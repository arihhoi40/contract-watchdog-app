require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const store = require('./store');

const FREE_MONTHLY_LIMIT = 3;

// Gumroad billing config — see .env.example for where to get these.
const GUMROAD_PRODUCT_URL = process.env.GUMROAD_PRODUCT_URL || '';
const GUMROAD_PRODUCT_PERMALINK = process.env.GUMROAD_PRODUCT_PERMALINK || '';
const GUMROAD_ACCESS_TOKEN = process.env.GUMROAD_ACCESS_TOKEN || '';

const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const MODEL = 'gemini-3.1-flash-lite';

// Gumroad's "Ping" webhook posts form-urlencoded data (not JSON) to this
// URL on every sale. Configure it in Gumroad under the product's
// Settings -> Advanced -> "Ping" URL, or via Settings -> Advanced for
// all products account-wide.
app.post('/api/gumroad-webhook', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const body = req.body || {};
    let sale = body;

    // If an access token is configured, re-fetch the sale from Gumroad's
    // API rather than trusting the raw ping — this stops someone from
    // just POSTing a fake "sale" to this endpoint to get a free upgrade.
    if (GUMROAD_ACCESS_TOKEN && body.sale_id) {
      const verifyRes = await fetch(
        `https://api.gumroad.com/v2/sales/${encodeURIComponent(body.sale_id)}?access_token=${encodeURIComponent(GUMROAD_ACCESS_TOKEN)}`
      );
      const verifyData = await verifyRes.json();
      if (!verifyRes.ok || !verifyData.success) {
        console.warn('Gumroad webhook: could not verify sale', body.sale_id);
        return res.status(400).send('Could not verify sale.');
      }
      sale = verifyData.sale;
    } else if (!GUMROAD_ACCESS_TOKEN) {
      console.warn('GUMROAD_ACCESS_TOKEN is not set — trusting the webhook payload unverified. Set it in .env for real deployments.');
    }

    if (GUMROAD_PRODUCT_PERMALINK && sale.product_permalink !== GUMROAD_PRODUCT_PERMALINK) {
      // A sale for a different product on this Gumroad account — ignore.
      return res.json({ ignored: true });
    }

    const email = sale.email || sale.purchaser_email;
    if (!email) return res.status(400).send('No email on sale.');

    const isRefundOrDispute = sale.refunded === true || sale.refunded === 'true' || sale.disputed === true || sale.disputed === 'true';
    const billingRef = sale.subscription_id || sale.sale_id || sale.id || null;

    if (isRefundOrDispute) {
      await store.setUserPlan(email, 'free');
      console.log(`Downgraded ${email} to free (refund/dispute).`);
    } else {
      await store.setUserPlan(email, 'pro', billingRef);
      console.log(`Upgraded ${email} to pro.`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Gumroad webhook error:', err);
    res.status(500).send('Webhook processing error.');
  }
});

app.use(express.json({ limit: '25mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.userEmail) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  next();
}

async function publicUser(user) {
  if (!user) return null;
  const used = await store.getUsageCount(user.email);
  return {
    email: user.email,
    plan: user.plan,
    usage: {
      used,
      limit: user.plan === 'pro' ? null : FREE_MONTHLY_LIMIT
    }
  };
}

// ---------- Auth routes ----------

app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !String(email).includes('@')) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (await store.findUser(email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await store.createUser(email, passwordHash);
  req.session.userEmail = user.email;
  res.json({ user: await publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = email && (await store.findUser(email));
  if (!user) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const ok = await bcrypt.compare(password || '', user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  req.session.userEmail = user.email;
  res.json({ user: await publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userEmail) return res.status(401).json({ error: 'Not logged in.' });
  const user = await store.findUser(req.session.userEmail);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ user: await publicUser(user) });
});

// ---------- Billing routes ----------

app.post('/api/create-checkout-session', requireAuth, async (req, res) => {
  if (!GUMROAD_PRODUCT_URL) {
    return res.status(500).json({ error: 'Billing is not configured on this server yet.' });
  }
  const url = new URL(GUMROAD_PRODUCT_URL);
  url.searchParams.set('email', req.session.userEmail);
  res.json({ url: url.toString() });
});

const BASE_GUIDELINES = `Guidelines:
- Find every clause that is one-sided, unusual, vague, or unfavorable to the party who would typically be signing without a lawyer (e.g. the contractor, tenant, employee, or customer rather than the drafting party). Flag these with type "risky_clause".
- Identify standard protections that a fair version of this type of contract would normally include but this one lacks (e.g. no cap on liability, no notice period, no dispute resolution process, no refund/cancellation terms). Flag these with type "missing_protection".
- Order flags roughly from most to least severe.
- The "quote" field must be copied exactly, character for character, from the contract text so it can be located with a simple search — do not paraphrase it. Leave "quote" as an empty string only when type is "missing_protection" and there is no existing clause to point to.
- Aim for 4-10 flags total for a typical contract; fewer for a very short/simple one, more for a long/complex one. Do not pad with trivial nitpicks.
- Be concrete and specific, not generic boilerplate warnings.
- "summary" should be 2-4 plain-English sentences, written for someone with no legal background.`;

function buildSystemPrompt(usingImages) {
  if (usingImages) {
    return `You are Contract Watchdog, an extremely careful contract reviewer. You will be given one or more photos of a contract, in page order. First transcribe the full text of the contract from the photos as accurately as possible (fix obvious OCR artifacts like stray line breaks, but keep the actual wording exact) into "extracted_text". Then analyze that text thoroughly.

${BASE_GUIDELINES}
- "extracted_text" must contain the complete transcribed contract text, in reading order across all pages.`;
  }
  return `You are Contract Watchdog, an extremely careful contract reviewer. You will be given the full text of a contract. Analyze it thoroughly.

${BASE_GUIDELINES}`;
}

function buildResponseSchema(usingImages) {
  const flagProperties = {
    type: { type: 'STRING', enum: ['risky_clause', 'missing_protection'] },
    severity: { type: 'STRING', enum: ['high', 'medium', 'low'] },
    title: { type: 'STRING' },
    quote: { type: 'STRING' },
    explanation: { type: 'STRING' },
    suggestion: { type: 'STRING' }
  };
  const flagRequired = ['type', 'severity', 'title', 'quote', 'explanation', 'suggestion'];

  const properties = {
    overall_risk: { type: 'STRING', enum: ['low', 'medium', 'high'] },
    summary: { type: 'STRING' },
    flags: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: flagProperties, required: flagRequired }
    }
  };
  const required = ['overall_risk', 'summary', 'flags'];

  if (usingImages) {
    properties.extracted_text = { type: 'STRING' };
    required.push('extracted_text');
  }

  return { type: 'OBJECT', properties, required };
}

app.post('/api/analyze', requireAuth, async (req, res) => {
  try {
    const user = await store.findUser(req.session.userEmail);
    if (!user) return res.status(401).json({ error: 'Not logged in.' });

    if (user.plan !== 'pro') {
      const used = await store.getUsageCount(user.email);
      if (used >= FREE_MONTHLY_LIMIT) {
        return res.status(402).json({
          error: 'limit_reached',
          message: `You've used all ${FREE_MONTHLY_LIMIT} free analyses this month.`,
          usage: { used, limit: FREE_MONTHLY_LIMIT }
        });
      }
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server has no GEMINI_API_KEY configured. Add it to your .env file and restart the server.' });
    }

    const { mode, text, images } = req.body || {};
    const usingImages = mode === 'photo';

    if (usingImages) {
      if (!Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ error: 'No photos were provided.' });
      }
    } else {
      if (!text || !String(text).trim()) {
        return res.status(400).json({ error: 'No contract text was provided.' });
      }
    }

    const systemPrompt = buildSystemPrompt(usingImages);
    const responseSchema = buildResponseSchema(usingImages);

    const userParts = usingImages
      ? [
          { text: 'Here are the photos of the contract, in page order. Transcribe and review them.' },
          ...images.map((img) => ({ inline_data: { mime_type: img.mimeType, data: img.base64 } }))
        ]
      : [{ text: 'Here is the contract to review:\n\n' + text }];

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const geminiResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: userParts }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: responseSchema,
          maxOutputTokens: usingImages ? 8000 : 4000
        }
      })
    });

    if (!geminiResponse.ok) {
      const status = geminiResponse.status;
      if (status === 400 || status === 403) {
        return res.status(502).json({ error: `Gemini rejected the request (${status}) — check that GEMINI_API_KEY in .env is correct and has API access.` });
      }
      return res.status(502).json({ error: `Gemini request failed (${status}).` });
    }

    const data = await geminiResponse.json();
    const candidate = (data.candidates || [])[0];
    const part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];
    if (!part || !part.text) {
      return res.status(502).json({ error: 'Gemini returned no content.' });
    }

    let raw = part.text.trim();
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        return res.status(502).json({ error: "Couldn't parse Gemini's response." });
      }
    }
    if (!parsed.flags) parsed.flags = [];

    let usageAfter = null;
    if (user.plan !== 'pro') {
      usageAfter = await store.incrementUsage(user.email);
    }

    return res.json({ result: parsed, usage: { used: usageAfter, limit: user.plan === 'pro' ? null : FREE_MONTHLY_LIMIT } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unexpected server error: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Contract Watchdog running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn('WARNING: GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.');
  }
  if (!GUMROAD_PRODUCT_URL) {
    console.warn('NOTE: Gumroad is not configured — the "Upgrade to Pro" button will show an error until GUMROAD_PRODUCT_URL is set in .env.');
  }
});


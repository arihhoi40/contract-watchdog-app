# Contract Watchdog

Paste or scan a contract, get risky clauses and missing protections flagged in plain English. Powered by Gemini 3.1 Flash Lite, called from a small Express backend so the API key never touches the browser.

Free plan: 3 analyses a month per account. Pro plan: unlimited, via Stripe subscription.

## Setup

1. **Install dependencies**
   ```
   npm install
   ```

2. **Configure `.env`**
   ```
   cp .env.example .env
   ```
   At minimum, set:
   ```
   GEMINI_API_KEY=your-gemini-key      # https://aistudio.google.com/apikey
   SESSION_SECRET=some-long-random-string
   ```
   Billing (`STRIPE_*`) is optional — without it, the app works fine, the "Upgrade to Pro" button just shows an error until you configure it.

3. **Run it**
   ```
   npm start
   ```
   Open http://localhost:3000

## Accounts & the free tier

- Anyone visiting the app signs up with an email + password (stored as a bcrypt hash in `data/users.json`).
- Each account gets **3 free analyses per calendar month**. Usage is tracked in `data/usage.json`.
- When the limit is hit, `/api/analyze` returns `402` and the frontend shows a paywall panel instead of the tool.
- `data/` is gitignored — it's local file storage, fine for one server instance. For real multi-instance deployment, swap `store.js` for a real database (the interface is small and easy to reimplement).

## Enabling the "Upgrade to Pro" button (Gumroad)

1. Create a subscription product on Gumroad (**gumroad.com/products/new**) — this is your "Pro" plan. Note its checkout link, e.g. `https://yourname.gumroad.com/l/pro-plan`, and its permalink (`pro-plan`, the part after `/l/`).
2. Add to `.env`:
   ```
   GUMROAD_PRODUCT_URL=https://yourname.gumroad.com/l/pro-plan
   GUMROAD_PRODUCT_PERMALINK=pro-plan
   ```
3. In the Gumroad dashboard, open the product's **Settings → Advanced** tab and set the **Ping (webhook) URL** to:
   ```
   https://your-domain.com/api/gumroad-webhook
   ```
   For local testing, use a tunnel (e.g. `ngrok http 3000`) and put the ngrok URL there instead, since Gumroad needs to reach your server over the public internet.
4. (Recommended) Under **Settings → Advanced → Applications**, generate a personal access token and add it as `GUMROAD_ACCESS_TOKEN` in `.env`. With this set, the server re-verifies every webhook against Gumroad's API instead of trusting the raw POST — without it, anyone who finds your webhook URL could POST a fake "sale" and get a free upgrade.
5. Optional: in the product's settings, set a "redirect after purchase" URL to `${APP_URL}/?upgraded=1` so buyers land back on the app after paying. If you skip this, they'll see Gumroad's own receipt page instead — the account still upgrades either way once the webhook fires.
6. Click "Upgrade to Pro" in the app, complete a real (or Gumroad test-mode) purchase, and the account should flip to Pro within a couple seconds of the webhook arriving.

**Known limitation:** Gumroad's webhook reliably fires on purchase; it does not reliably notify this app when a subscription is later cancelled or lapses, so the code only auto-downgrades on an explicit refund/dispute. For a production deployment, you'd want a periodic check against Gumroad's API (or Gumroad's subscriber management) to catch lapsed subscriptions.

In production, replace the `stripe listen` step with a real webhook endpoint configured in the Stripe dashboard, pointed at `https://your-domain.com/api/stripe-webhook`.

## How it works

- `public/index.html` — the whole frontend. Handles login/signup, the paste/scan tool, and the paywall. Never sees any API key.
- `server.js` — Express server. Holds `GEMINI_API_KEY` and `STRIPE_SECRET_KEY`, handles sessions/auth, enforces the free-tier limit, calls Gemini, and creates/receives Stripe checkout sessions.
- `store.js` — tiny JSON-file-backed data layer for users and monthly usage counts.

## Notes

- `.env` and `data/` are gitignored — don't commit your keys or user data.
- Sessions use `express-session`'s default in-memory store, so everyone gets logged out if you restart the server. Fine for a single small deployment; swap in a store like `connect-redis` for anything more serious.
- If you deploy this publicly, consider rate limiting `/api/signup` and `/api/login` to slow down brute-force attempts.

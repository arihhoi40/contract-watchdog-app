const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env — copy .env.example, ' +
    'fill in your Supabase project URL and service_role key, and restart the server.'
  );
}

// service_role key bypasses RLS — this client should only ever run on the
// server, never be sent to the browser.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// ---------- Users ----------
// NOTE: all functions below are synchronous-looking in server.js's calling
// code (no `await`) in the old file-based version, but Supabase calls are
// inherently async. server.js already `await`s createUser/setUserPlan/etc.
// where it matters (see server.js — those calls are all in async route
// handlers). If you added new callers, make sure to `await` these.

async function findUser(email) {
  const key = email.toLowerCase();
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', key)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    email: data.email,
    passwordHash: data.password_hash,
    plan: data.plan,
    billingRef: data.billing_ref,
    createdAt: data.created_at
  };
}

async function createUser(email, passwordHash) {
  const key = email.toLowerCase();
  const { data, error } = await supabase
    .from('users')
    .insert({ email: key, password_hash: passwordHash, plan: 'free' })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') return null; // duplicate email
    throw error;
  }
  return {
    email: data.email,
    passwordHash: data.password_hash,
    plan: data.plan,
    billingRef: data.billing_ref,
    createdAt: data.created_at
  };
}

async function setUserPlan(email, plan, billingRef) {
  const key = email.toLowerCase();
  const update = { plan };
  if (billingRef) update.billing_ref = billingRef;
  const { data, error } = await supabase
    .from('users')
    .update(update)
    .eq('email', key)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    email: data.email,
    passwordHash: data.password_hash,
    plan: data.plan,
    billingRef: data.billing_ref,
    createdAt: data.created_at
  };
}

async function findUserByBillingRef(billingRef) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('billing_ref', billingRef)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    email: data.email,
    passwordHash: data.password_hash,
    plan: data.plan,
    billingRef: data.billing_ref,
    createdAt: data.created_at
  };
}

// ---------- Usage ----------

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7); // "2026-07"
}

async function getUsageCount(email) {
  const key = email.toLowerCase();
  const month = currentMonthKey();
  const { data, error } = await supabase
    .from('usage')
    .select('count')
    .eq('email', key)
    .eq('month', month)
    .maybeSingle();
  if (error) throw error;
  return (data && data.count) || 0;
}

async function incrementUsage(email) {
  const key = email.toLowerCase();
  const month = currentMonthKey();

  // Read-then-write. Fine at this app's scale (one increment per analysis
  // click); if you ever need this to be race-safe under heavy concurrent
  // load, replace with a Postgres function that does an atomic upsert.
  const { data: existing, error: selectError } = await supabase
    .from('usage')
    .select('count')
    .eq('email', key)
    .eq('month', month)
    .maybeSingle();
  if (selectError) throw selectError;

  const newCount = ((existing && existing.count) || 0) + 1;

  const { error: upsertError } = await supabase
    .from('usage')
    .upsert({ email: key, month, count: newCount }, { onConflict: 'email,month' });
  if (upsertError) throw upsertError;

  return newCount;
}

module.exports = {
  findUser,
  createUser,
  setUserPlan,
  findUserByBillingRef,
  getUsageCount,
  incrementUsage,
  currentMonthKey
};

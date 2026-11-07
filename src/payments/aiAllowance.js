/**
 * Safety Pro's AI allowance: the AI runs a pass covers (full token reports,
 * proposal summaries, and later the AI write-ups of other agents) are
 * counted at what each one actually cost RektBull in Claude usage, up to
 * SAFETY_PRO.ai_allowance.cents_per_30_days in each 30 days of the pass.
 * A cached answer cost nothing, so it uses nothing; a failed run is never
 * counted. When it's used up, the run falls through to the other ways to pay
 * (points, credits, x402) at the normal price.
 *
 * The cost of a run is measured, not guessed: meter() runs a function and
 * adds up every Claude call made inside it (src/ai/claude.js reports each
 * call's tokens to the meter).
 *
 * Periods run from the pass's start in 30-day steps, so a 365-day pass gets a
 * fresh allowance every 30 days rather than all of it at once. The check is
 * made before the run, so the last run of a period can go over by at most
 * one run's cost (a report is capped at 4,000 output tokens, about $0.11).
 */
const { AsyncLocalStorage } = require('async_hooks');
const db = require('../config/db');
const { SAFETY_PRO } = require('./catalog');

const DAY_MS = 86400000;
const PERIOD_DAYS = 30;
const store = new AsyncLocalStorage();

/** Runs fn, measuring the AI it uses: { result, usd }. */
async function meter(fn) {
  const m = { usd: 0, calls: 0 };
  const result = await store.run(m, fn);
  return { result, usd: m.usd, calls: m.calls };
}

/** Called by src/ai/claude.js for each call: adds its cost to the run being metered, if any. */
function add(usd) {
  const m = store.getStore();
  if (m) { m.usd += usd; m.calls += 1; }
}

/** The allowance period a pass is in now: its key, and when it resets. */
function period(pass, now = Date.now()) {
  const start = new Date(pass.starts_at).getTime();
  const index = Math.max(0, Math.floor((now - start) / (PERIOD_DAYS * DAY_MS)));
  const resets = Math.min(start + (index + 1) * PERIOD_DAYS * DAY_MS, new Date(pass.ends_at).getTime());
  return { key: `pass:${pass.id}:${index}`, resets_at: new Date(resets).toISOString() };
}

const allowanceCents = () => SAFETY_PRO.ai_allowance.cents_per_30_days;

async function usedUsd(accountId, key) {
  const { rows } = await db.query('SELECT used_usd FROM ai_allowance_usage WHERE account_id = $1 AND period = $2', [accountId, key]);
  return rows.length ? Number(rows[0].used_usd) : 0;
}

/** True while this period's allowance isn't used up. */
async function hasRoom(accountId, pass) {
  return (await usedUsd(accountId, period(pass).key)) < allowanceCents() / 100;
}

/** Counts a successful run's AI cost against the pass's current period. */
async function charge(accountId, pass, usd) {
  if (!(usd > 0)) return;
  await db.query(
    `INSERT INTO ai_allowance_usage (account_id, period, used_usd, runs) VALUES ($1, $2, $3, 1)
     ON CONFLICT (account_id, period) DO UPDATE SET used_usd = ai_allowance_usage.used_usd + $3, runs = ai_allowance_usage.runs + 1, updated_at = now()`,
    [accountId, period(pass).key, usd],
  );
}

/** What's left now for the account's active Safety Pro pass, or null without one. */
async function status(accountId) {
  const pass = await require('./passes').covering(accountId, 'token_report');
  if (!pass) return null;
  const p = period(pass);
  const used = await usedUsd(accountId, p.key);
  const allowance = allowanceCents() / 100;
  // Shown to people as a percentage left, like an AI subscription's usage meter.
  const leftPct = Math.max(0, Math.min(100, Math.ceil((1 - used / allowance) * 100))); // 0% only once it is used up
  return {
    left_pct: leftPct,
    used_pct: 100 - leftPct,
    resets_at: p.resets_at,
    allowance_usd: allowance,
    used_usd: Math.round(used * 10000) / 10000,
    covers: SAFETY_PRO.ai_allowance.uses,
  };
}

module.exports = { meter, add, period, hasRoom, charge, status, PERIOD_DAYS };

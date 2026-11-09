/**
 * Counts calls to each data provider per UTC day, so RektBull stays inside
 * free plans. Limits come from PROVIDER_DAILY_LIMITS. At 80% of a limit it
 * warns once a day; at 100% the provider is skipped (callers fall back to
 * the next one) until the day turns over.
 *
 * The admin panel (docs/ADMIN.md) can switch a provider off, or set its own
 * daily limit in place of PROVIDER_DAILY_LIMITS (admin_settings provider:<name>).
 * Either way the caller sees the same refusal, so its fallback takes over.
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');

const WARN_AT = 0.8;

class ProviderLimitError extends Error {
  constructor(provider, message = `${provider} has used today's free-plan allowance`) {
    super(message);
    this.provider = provider;
    this.isProviderLimit = true;
  }
}

/** What an admin set for this provider: { off, daily_limit }. A dynamic name (rpc:<host>) also takes its family's (rpc). */
const adminFor = provider => {
  const settings = require('../admin/settings');
  return settings.get(`provider:${provider}`) || (provider.includes(':') ? settings.get(`provider:${provider.split(':')[0]}`) : null) || {};
};
const limitFor = provider => adminFor(provider).daily_limit ?? env.providerDailyLimits[provider];

const today = () => new Date().toISOString().slice(0, 10);

// In-process counts, so a limit check never waits on the database.
const counts = new Map(); // `${provider}|${day}` -> calls
const warned = new Set();

/** 'ok', 'warn' (crossed 80%) or 'blocked' (at or over the limit). */
function level(calls, limit) {
  if (!limit) return 'ok';
  if (calls >= limit) return 'blocked';
  if (calls >= limit * WARN_AT) return 'warn';
  return 'ok';
}

function record(provider, { error = null } = {}) {
  if (!env.databaseUrl) return;
  const why = error ? String(error.message || error).replace(/(api_?key|apikey|token|key)=[^&\s]+/gi, '$1=…').slice(0, 300) : null;
  db.query(
    `INSERT INTO provider_usage (provider, day, calls, errors, last_call_at, last_error_at, last_error)
     VALUES ($1, $2, 1, $3, now(), CASE WHEN $3 = 1 THEN now() END, $4)
     ON CONFLICT (provider, day) DO UPDATE SET calls = provider_usage.calls + 1, errors = provider_usage.errors + $3, last_call_at = now(),
       last_error_at = CASE WHEN $3 = 1 THEN now() ELSE provider_usage.last_error_at END,
       last_error = CASE WHEN $3 = 1 THEN $4 ELSE provider_usage.last_error END`,
    [provider, today(), error ? 1 : 0, why],
  ).catch(err => logger.warn('provider usage write failed', { provider, error: err.message }));
}

/**
 * Runs fn as one call to provider: refuses it when the day's limit is used,
 * counts it, and records whether it failed.
 */
async function track(provider, fn) {
  const day = today();
  const key = `${provider}|${day}`;
  const calls = counts.get(key) || 0;
  if (adminFor(provider).off) throw new ProviderLimitError(provider, `${provider} is switched off in the admin panel`);
  const limit = limitFor(provider);
  const lvl = level(calls, limit);
  if (lvl === 'blocked') throw new ProviderLimitError(provider);
  if (lvl === 'warn' && !warned.has(key)) {
    warned.add(key);
    logger.warn('provider near its free-plan limit', { provider, calls, limit });
  }
  counts.set(key, calls + 1);
  try {
    const out = await fn();
    record(provider);
    return out;
  } catch (err) {
    record(provider, { error: err });
    throw err;
  }
}

async function report(days = 7) {
  const { rows } = await db.query(
    `SELECT provider, day, calls, errors FROM provider_usage WHERE day > current_date - $1::int ORDER BY day DESC, provider`,
    [days],
  );
  return rows.map(r => ({ ...r, limit: limitFor(r.provider) || null }));
}

module.exports = { track, level, report, limitFor, adminFor, ProviderLimitError, _counts: counts };

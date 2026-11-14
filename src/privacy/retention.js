/**
 * How long RektBull keeps data it no longer needs, run by the worker every
 * hour. The privacy page (/privacy) states these same periods; change both
 * together.
 */
const db = require('../config/db');

const RULES = [
  ['sign-in requests, a day after they expire', `DELETE FROM siwe_challenges WHERE expires_at < now() - interval '1 day'`],
  ['linking and email-confirmation codes, a day after they expire', `DELETE FROM alert_link_codes WHERE expires_at < now() - interval '1 day'`],
  ['daily free-use counters (some keyed by a hashed IP address), after 40 days', `DELETE FROM free_usage WHERE day < CURRENT_DATE - 40`],
  ['monthly points and pass counters, after 13 months', `DELETE FROM period_usage WHERE period < to_char(now() - interval '13 months', 'YYYY-MM')`],
  ['alert delivery records, after 90 days', `DELETE FROM alert_deliveries WHERE COALESCE(sent_at, next_attempt_at) < now() - interval '90 days'`],
  ['risk monitor alerts, after a year', `DELETE FROM monitor_alerts WHERE created_at < now() - interval '1 year'`],
  ['trades read from the chain for followed wallets (public facts, not tied to an account), after 35 days', `DELETE FROM wallet_trades WHERE seen_at < now() - interval '35 days'`],
  ['newsletter sign-ups never confirmed, after 7 days', `DELETE FROM newsletter_subscribers WHERE confirmed_at IS NULL AND created_at < now() - interval '7 days'`],
  ['revoked or expired extension links, after 30 days', `DELETE FROM extension_tokens WHERE COALESCE(revoked_at, expires_at) < now() - interval '30 days'`],
];

async function purge() {
  const done = {};
  for (const [what, sql] of RULES) done[what] = (await db.query(sql)).rowCount;
  return done;
}

module.exports = { purge, RULES };

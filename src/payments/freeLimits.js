/**
 * The daily free allowances, by product key: the HTTP routes and the MCP
 * server's tools share them, so a free check costs the same allowance
 * whichever way it's asked for. Signed in, a wallet gets the higher number;
 * without signing in, the counter is keyed by a hashed IP address.
 */
const env = require('../config/env');
const { takeAllowance } = require('./gate');

const FREE_LIMITS = {
  home_lookup: { account: 120, anonymous: 30 },
  home_checkup: { account: 10, anonymous: 3 },
  approval_preview: { account: 10, anonymous: 3 },
  claims_check: { account: 30, anonymous: 5 },
  claims_prepare: { account: 30, anonymous: 10 },
  yield_wallet: { account: 30, anonymous: 5 },
  yield_prepare: { account: 30, anonymous: 10 },
  governance_check: { account: 60, anonymous: 10 },
  discover_flags: { account: 100, anonymous: 20 },
  portfolio: { account: 30, anonymous: 5 },
};

/** Takes one use of `key` for this request's account or IP. { ok, limit, signedIn } */
async function takeFree(req, key) {
  const limits = FREE_LIMITS[key];
  const signedIn = !!req.account;
  const [subject, limit] = signedIn ? [`account:${req.account.id}`, limits.account] : [require('../privacy/ipKey').ipSubject(req.ip), limits.anonymous];
  const ok = !env.databaseUrl || await takeAllowance(subject, key, limit);
  return { ok, limit, signedIn };
}

module.exports = { FREE_LIMITS, takeFree };

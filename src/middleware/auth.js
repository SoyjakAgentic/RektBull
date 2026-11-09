const env = require('../config/env');
const { readToken } = require('../auth/siwe');

/**
 * Sets req.account from a Bearer token, if there is a valid one. An
 * extension token (scope 'extension') counts only on the few routes it's
 * for, and only while it isn't revoked.
 */
async function optionalAuth(req, _res, next) {
  try {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    let account = m ? readToken(m[1]) : null;
    if (account?.scope) {
      const ext = require('../auth/extensionTokens');
      if (account.scope !== 'extension' || !ext.allowed(req.method, req.path) || !(await ext.isActive(account.jti))) account = null;
    }
    req.account = account;
    next();
  } catch (err) { next(err); }
}

function requireAuth(req, res, next) {
  if (!req.account) return res.status(401).json({ error: 'sign_in_required', message: 'Sign in with your wallet first (POST /v1/auth/nonce).' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.account || !env.adminWallets.includes(req.account.wallet)) return res.status(403).json({ error: 'forbidden' });
  next();
}

/** Changes in the admin panel need a sign-in from the last 15 minutes: a fresh wallet signature, not an old session. */
const FRESH_SECONDS = 15 * 60;
function requireFreshAdmin(req, res, next) {
  if (!req.account || req.account.scope || !env.adminWallets.includes(req.account.wallet)) return res.status(403).json({ error: 'forbidden' });
  if (!req.account.iat || Date.now() / 1000 - req.account.iat > FRESH_SECONDS) {
    return res.status(401).json({ error: 'sign_in_again', message: 'Sign in again with your wallet to make changes (an admin change needs a signature from the last 15 minutes).' });
  }
  next();
}

module.exports = { optionalAuth, requireAuth, requireAdmin, requireFreshAdmin, FRESH_SECONDS };

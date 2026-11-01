const env = require('../config/env');
const { readToken } = require('../auth/siwe');

/** Sets req.account from a Bearer session token, if there is a valid one. */
function optionalAuth(req, _res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  req.account = m ? readToken(m[1]) : null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.account) return res.status(401).json({ error: 'sign_in_required', message: 'Sign in with your wallet first (POST /v1/auth/nonce).' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.account || !env.adminWallets.includes(req.account.wallet)) return res.status(403).json({ error: 'forbidden' });
  next();
}

module.exports = { optionalAuth, requireAuth, requireAdmin };

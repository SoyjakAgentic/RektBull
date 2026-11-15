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
    // A wallet blocked in the admin panel is treated as signed out (admin/accounts.js).
    const { isBlocked } = require('../admin/accounts');
    if (account && (isBlocked(account.wallet) || isBlocked(account.solana_wallet))) account = null;
    req.account = account;
    next();
  } catch (err) { next(err); }
}

function requireAuth(req, res, next) {
  if (!req.account) return res.status(401).json({ error: 'sign_in_required', message: 'Sign in with your wallet first (POST /v1/auth/nonce).' });
  next();
}

/**
 * For features that act on an EVM wallet (EVM trading, permissions, yield):
 * an account signed in with only a Solana wallet is asked to link one.
 */
async function requireEvmWallet(req, res, next) {
  try {
    if (!req.account) return requireAuth(req, res, next);
    // The wallets as stored now: a session token can predate a link or an unlink.
    const now = await require('../auth/siwe').wallets(req.account.id);
    if (!now) return res.status(401).json({ error: 'sign_in_required', message: 'Sign in with your wallet first (POST /v1/auth/nonce).' });
    req.account = { ...req.account, wallet: now.wallet, solana_wallet: now.solana_wallet };
    if (!now.wallet) return res.status(409).json({ error: 'evm_wallet_required', message: 'This needs an EVM wallet (MetaMask, Coinbase Wallet, Rabby…). Link one to your account first: it only takes a signature.' });
    next();
  } catch (err) { next(err); }
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

module.exports = { optionalAuth, requireAuth, requireEvmWallet, requireAdmin, requireFreshAdmin, FRESH_SECONDS };

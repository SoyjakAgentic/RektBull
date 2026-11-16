/**
 * Hyperliquid perps (docs/HYPERLIQUID.md).
 *
 * Reading (markets, an account's positions and orders, its approvals) is
 * open to every signed-in wallet in every country. Trading goes through the
 * relay (hyperliquid/relay.js): the page signs in the browser, with an agent
 * key that never leaves it, and the relay passes the signed action on.
 * Nothing here signs for a user, and no key is ever received.
 */
const express = require('express');
const env = require('../config/env');
const { requireEvmWallet } = require('../middleware/auth');
const hl = require('../providers/hyperliquid');
const markets = require('../hyperliquid/markets');
const relay = require('../hyperliquid/relay');

const router = express.Router();

/** The manual agent: the name the page approves its browser key under, and for how long. */
const WEB_AGENT = { name: 'rektbull-web', days: 30, max_days: 180 };
const APPS = { mainnet: 'https://app.hyperliquid.xyz', testnet: 'https://app.hyperliquid-testnet.xyz' };

const refusal = fn => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof relay.RelayRefused) return res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra || {}) });
    if (err.isHyperliquid || err.isProviderLimit) return res.status(err.status || 503).json({ error: 'hyperliquid_unavailable', message: err.isProviderLimit ? `Hyperliquid couldn't be reached: ${err.message}.` : err.message });
    throw err;
  }
};

function config() {
  return {
    enabled: env.hlEnabled,
    network: hl.network(),
    source: hl.SOURCE,
    app_url: APPS[hl.network()],
    // Deposits and withdrawals are made on Hyperliquid itself, from the user's own wallet: RektBull's relay never carries one.
    deposit_url: `${APPS[hl.network()]}/trade`,
    agent: WEB_AGENT,
    order: { min_usd: 10, slippage_pct: 1, max_slippage_pct: 5, expires_seconds: 30 },
  };
}
router.get('/v1/hyperliquid/config', (_req, res) => res.json(config()));

router.get('/v1/hyperliquid/markets', refusal(async (_req, res) => {
  const list = await markets.markets();
  res.set('cache-control', 'public, max-age=3');
  res.json({ network: hl.network(), source: hl.SOURCE, as_of: new Date().toISOString(), markets: list.filter(m => !m.delisted) });
}));

router.get('/v1/hyperliquid/account', requireEvmWallet, refusal(async (req, res) => {
  res.json(await markets.account(req.account.wallet, req.query.fresh ? { ms: 0 } : {}));
}));

router.get('/v1/hyperliquid/approvals', requireEvmWallet, refusal(async (req, res) => {
  res.json(await markets.approvals(req.account.wallet));
}));

/** A signed action, passed on to Hyperliquid. */
router.post('/v1/hyperliquid/exchange', requireEvmWallet, refusal(async (req, res) => {
  res.json(await relay.send(req.body, { wallet: req.account.wallet }));
}));

module.exports = router;
module.exports.config = config;
module.exports.WEB_AGENT = WEB_AGENT;

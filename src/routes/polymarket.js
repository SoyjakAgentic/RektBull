/**
 * Polymarket endpoints (docs/POLYMARKET.md). Reads are public and cached.
 * RektBull prepares orders and wallet set-up for the user's wallet to sign;
 * it never signs for a user and never sees their CLOB API credentials: the
 * browser sends signed orders straight to Polymarket.
 */
const express = require('express');
const env = require('../config/env');
const pm = require('../providers/polymarket');
const markets = require('../polymarket/markets');
const desk = require('../polymarket/desk');
const wallets = require('../polymarket/wallets');
const { requireAuth, requireEvmWallet } = require('../middleware/auth');
const regions = require('../compliance/regions');

const router = express.Router();

/** A read that failed answers with which Polymarket API failed and why; never an empty list that looks like "no markets". */
const read = fn => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err.isPolymarketUnavailable) return res.status(err.status).json({ error: 'source_unavailable', source: err.source, message: err.message });
    if (err.isOrderRefused || err.isWalletRefused) return res.status(err.status).json({ error: err.code, message: err.message });
    throw err;
  }
};
const isAddress = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const slugOk = s => /^[a-z0-9-]{1,200}$/.test(String(s || ''));
const idOk = s => /^[0-9]{1,80}$/.test(String(s || ''));

router.get('/v1/polymarket/events', read(async (req, res) => {
  res.set('cache-control', 'public, max-age=30');
  res.json(await markets.browse({ q: req.query.q, limit: req.query.limit, offset: req.query.offset, tag: req.query.tag }));
}));

router.get('/v1/polymarket/events/:slug', read(async (req, res) => {
  if (!slugOk(req.params.slug)) return res.status(400).json({ error: 'bad_request', message: 'not an event slug' });
  const out = await markets.eventBySlug(req.params.slug);
  if (!out) return res.status(404).json({ error: 'not_found', message: 'Polymarket has no event with that slug.' });
  res.json(out);
}));

router.get('/v1/polymarket/markets/:slug', read(async (req, res) => {
  if (!slugOk(req.params.slug)) return res.status(400).json({ error: 'bad_request', message: 'not a market slug' });
  const out = await markets.marketBySlug(req.params.slug);
  if (!out) return res.status(404).json({ error: 'not_found', message: 'Polymarket has no market with that slug.' });
  res.json(out);
}));

router.get('/v1/polymarket/books/:assetId', read(async (req, res) => {
  if (!idOk(req.params.assetId)) return res.status(400).json({ error: 'bad_request', message: 'asset_id must be the outcome\'s numeric id' });
  res.json(markets.presentBook(await pm.book(req.params.assetId)));
}));

/** Positions and PnL of any Polymarket wallet (public data; the page passes the user's own). */
router.get('/v1/polymarket/positions', read(async (req, res) => {
  if (!isAddress(req.query.wallet)) return res.status(400).json({ error: 'bad_request', message: 'wallet must be a Polymarket wallet address (0x…)' });
  res.json(await markets.positionsFor(req.query.wallet));
}));

// ── Trading: everything below prepares something for the signed-in wallet to sign ──

/**
 * The one place a region block applies: every route that prepares an order, a trading approval
 * or any other Polymarket wallet transaction passes through here first.
 * (Polymarket also blocks by the IP that sends the order, which is the user's own browser:
 * the page asks https://polymarket.com/api/geoblock before it offers to trade.)
 */
function regionGate(req, res, next) {
  // Getting out is never blocked: selling, redeeming winnings, withdrawing, and sending what was already prepared.
  const kind = String(req.body?.kind || '');
  if (req.path.endsWith('/submit') || (req.path.endsWith('/transactions') && kind !== 'approvals') || (req.path === '/v1/polymarket/orders' && String(req.body?.side || '').toUpperCase() === 'SELL')) return next();
  const r = regions.blockedFor(req, 'polymarket');
  if (r.blocked) return res.status(451).json({ error: 'region_blocked', message: r.reason });
  next();
}

router.get('/v1/polymarket/config', (_req, res) => res.json(desk.config()));

/** The signed-in wallet's Polymarket wallet: its address, whether it's deployed and funded, and each approval. */
router.get('/v1/polymarket/wallet', requireEvmWallet, read(async (req, res) => res.json(await wallets.status(req.account, { walletType: req.query.wallet_type || 'deposit', address: req.query.address || null }))));
router.post('/v1/polymarket/wallet/deploy', requireEvmWallet, regionGate, read(async (req, res) => res.status(201).json(await wallets.deploy(req.account))));
/** Fund from the user's own Polygon USDC.e (two transactions their wallet sends). */
router.post('/v1/polymarket/wallet/fund', requireEvmWallet, regionGate, read(async (req, res) => res.json(await wallets.fundCalls(req.account, req.body || {}))));
/** A wallet transaction to sign: kind is approvals, redeem or withdraw. */
router.post('/v1/polymarket/wallet/transactions', requireEvmWallet, regionGate, read(async (req, res) => {
  const kind = String(req.body?.kind || '');
  if (!['approvals', 'redeem', 'withdraw'].includes(kind)) return res.status(400).json({ error: 'bad_request', message: 'kind must be approvals, redeem or withdraw' });
  res.status(201).json(await wallets.prepare(req.account, kind, req.body || {}));
}));
/** The relay: forwards a transaction prepared above, with the wallet's signature, to Polymarket's relayer. */
router.post('/v1/polymarket/wallet/transactions/:id/submit', requireEvmWallet, regionGate, read(async (req, res) => res.json(await wallets.submit(req.account, req.params.id, String(req.body?.signature || '')))));
router.get('/v1/polymarket/wallet/transactions/:id', requireAuth, read(async (req, res) => res.json(await wallets.progress(req.account, req.params.id))));

/** An order for the wallet to sign. The browser sends the signed order to Polymarket itself. */
router.post('/v1/polymarket/orders', requireEvmWallet, regionGate, read(async (req, res) => res.status(201).json(await desk.prepare(req.account, req.body || {}))));
router.get('/v1/polymarket/orders', requireAuth, async (req, res) => res.json({ orders: await desk.list(req.account) }));
router.post('/v1/polymarket/orders/:id/result', requireAuth, async (req, res) => res.json(await desk.result(req.account, req.params.id, req.body || {})));
router.post('/v1/polymarket/orders/:id/cancelled', requireAuth, async (req, res) => res.json(await desk.cancelled(req.account, req.params.id)));

module.exports = router;
module.exports.read = read;

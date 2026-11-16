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

const router = express.Router();

/** A read that failed answers with which Polymarket API failed and why; never an empty list that looks like "no markets". */
const read = fn => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err.isPolymarketUnavailable) return res.status(err.status).json({ error: 'source_unavailable', source: err.source, message: err.message });
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

module.exports = router;
module.exports.read = read;

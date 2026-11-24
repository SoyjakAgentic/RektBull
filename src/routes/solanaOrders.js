/**
 * Orders on Solana (trade/solanaOrders.js): stop-losses, take-profits and
 * Meme Watch exits the user places in RektBull's order program. RektBull
 * prepares each transaction; the user's own wallet signs and sends it.
 * Placing an order is new work, so it's refused while the Trade desk is
 * paused; cancelling never is.
 */
const express = require('express');
const { requireAuth, currentWallets } = require('../middleware/auth');
const services = require('../admin/services');
const orders = require('../trade/solanaOrders');

const router = express.Router();

/** A refusal answers with its status and the reason. */
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err.isTradeBlocked) return res.status(err.status || 422).json({ error: 'order_refused', message: err.message, ...(err.needsAcknowledgement ? { needs_acknowledgement: true, risks: err.risks } : {}) });
    next(err);
  }
};

router.get('/v1/solana/orders', requireAuth, handle(async (req, res) => res.json(await orders.list(req.account))));
router.post('/v1/solana/orders', currentWallets, services.gate('trade'), handle(async (req, res) => res.status(201).json(await orders.prepare(req.account, req.body || {}))));
router.post('/v1/solana/orders/:id/confirm', requireAuth, handle(async (req, res) => res.json(await orders.confirm(req.account, req.params.id))));
router.post('/v1/solana/orders/:id/cancel', requireAuth, handle(async (req, res) => res.json(await orders.cancel(req.account, req.params.id))));
router.post('/v1/solana/orders/:id/refresh', requireAuth, handle(async (req, res) => res.json(await orders.refresh(req.account, req.params.id))));

module.exports = router;

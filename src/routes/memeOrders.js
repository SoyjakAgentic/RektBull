/**
 * Orders on BNB Chain and Base (trade/memeOrders.js): limit buys, stop-losses,
 * take-profits and Meme Watch exits the user's wallet signs, filled through the
 * Meme Router. RektBull prepares each order and call; the user's own wallet
 * signs and sends them. Placing an order is new work, so it's refused while the
 * Trade desk is paused; cancelling never is.
 */
const express = require('express');
const { requireAuth, requireEvmWallet } = require('../middleware/auth');
const services = require('../admin/services');
const orders = require('../trade/memeOrders');

const router = express.Router();

/** A refusal answers with its status and the reason. */
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err.isTradeBlocked) return res.status(err.status || 422).json({ error: 'order_refused', message: err.message, ...(err.needsAcknowledgement ? { needs_acknowledgement: true, risks: err.risks } : {}) });
    next(err);
  }
};

router.get('/v1/evm/orders', requireAuth, handle(async (req, res) => res.json(await orders.list(req.account))));
router.post('/v1/evm/orders', requireEvmWallet, services.gate('trade'), handle(async (req, res) => res.status(201).json(await orders.prepare(req.account, req.body || {}))));
// Every order on one chain at once (the router's cancelAll), and every approval revoked.
router.post('/v1/evm/orders/cancel-all', requireEvmWallet, handle(async (req, res) => res.json(await orders.cancelAll(req.account, req.body || {}))));
router.post('/v1/evm/orders/:id/sign', requireAuth, handle(async (req, res) => res.json(await orders.sign(req.account, req.params.id, req.body || {}))));
router.post('/v1/evm/orders/:id/cancel', requireAuth, handle(async (req, res) => res.json(await orders.cancel(req.account, req.params.id))));
router.post('/v1/evm/orders/:id/refresh', requireAuth, handle(async (req, res) => res.json(await orders.refresh(req.account, req.params.id))));

module.exports = router;

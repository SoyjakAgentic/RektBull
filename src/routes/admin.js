/**
 * The admin panel's API (/admin). Only wallets in ADMIN_WALLETS; every change
 * needs a sign-in from the last 15 minutes and a reason, and is logged with
 * what it was before (admin_log). Nothing here can move money, read or set a
 * key, or change a contract.
 */
const express = require('express');
const { requireAuth, requireAdmin, requireFreshAdmin } = require('../middleware/auth');
const catalog = require('../payments/catalog');
const settings = require('../admin/settings');
const agentStates = require('../admin/agentStates');
const stops = require('../admin/stops');

const router = express.Router();
const admin = [requireAuth, requireAdmin];
const change = [requireAuth, requireFreshAdmin];
const who = req => req.account.wallet;
const reasonOf = req => {
  const r = String(req.body?.reason || '').trim();
  if (r.length < 3) throw Object.assign(new Error('Say why (reason), so the log explains the change.'), { status: 400 });
  return r;
};
const ints = (body, keys) => Object.fromEntries(keys.filter(k => body?.[k] !== undefined).map(k => [k, Number(body[k])]));

/** Everything the panel shows in one read. */
router.get('/v1/admin/overview', admin, async (_req, res) => {
  await settings.reload();
  res.json({
    prices: catalog.adminPrices(),
    agents: agentStates.adminList(),
    stops: await stops.list(),
    log: await settings.log({ limit: 50 }),
  });
});

router.get('/v1/admin/log', admin, async (req, res) => res.json({ log: await settings.log({ limit: req.query.limit, key: req.query.key || null }) }));

/* ── prices ── */

router.put('/v1/admin/prices/:product', change, async (req, res) => {
  const reason = reasonOf(req);
  const value = catalog.checkPrice(req.params.product, ints(req.body, ['price_cents', 'points', 'fee_bps', 'pro_fee_bps']));
  await settings.set(`price:${req.params.product}`, value, { wallet: who(req), action: 'price', reason });
  res.json({ product: catalog.adminPrices().products.find(p => p.id === req.params.product) });
});

router.delete('/v1/admin/prices/:product', change, async (req, res) => {
  const reason = reasonOf(req);
  if (!catalog.PRODUCTS[req.params.product]) return res.status(404).json({ error: 'not_found' });
  await settings.set(`price:${req.params.product}`, null, { wallet: who(req), action: 'price_default', reason });
  res.json({ product: catalog.adminPrices().products.find(p => p.id === req.params.product) });
});

router.put('/v1/admin/free-points', change, async (req, res) => {
  const reason = reasonOf(req);
  const value = catalog.checkFreePoints(ints(req.body, ['per_month', 'new_wallet', 'per_ip_per_day']));
  await settings.set('free_points', value, { wallet: who(req), action: 'free_points', reason });
  res.json({ free_points: catalog.adminPrices().free_points });
});

router.put('/v1/admin/ai-allowance', change, async (req, res) => {
  const reason = reasonOf(req);
  const value = catalog.checkAiAllowance(Number(req.body?.cents_per_30_days));
  await settings.set('ai_allowance', value, { wallet: who(req), action: 'ai_allowance', reason });
  res.json({ ai_allowance: catalog.adminPrices().ai_allowance });
});

/* ── agents ── */

router.put('/v1/admin/agents/:id', change, async (req, res) => {
  const reason = reasonOf(req);
  res.json(await agentStates.setState(req.params.id, String(req.body?.state || ''), { wallet: who(req), reason }));
});

/* ── emergency stops ── */

router.put('/v1/admin/stops/:id', change, async (req, res) => {
  const reason = reasonOf(req);
  res.json(await stops.set(req.params.id, req.body?.on, { wallet: who(req), reason }));
});

module.exports = router;

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
const services = require('../admin/services');

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
    services: await services.list(),
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

/* ── services: pause any of them (admin/services.js); pausing never blocks a way out ── */

router.put('/v1/admin/services/:id', change, async (req, res) => {
  const reason = reasonOf(req);
  res.json(await services.set(req.params.id, req.body?.state ?? req.body?.paused, { wallet: who(req), reason }));
});

/* ── emergency stops ── */

router.put('/v1/admin/stops/:id', change, async (req, res) => {
  const reason = reasonOf(req);
  res.json(await stops.set(req.params.id, req.body?.on, { wallet: who(req), reason }));
});

/* ── external services (part 2): numbers, a switch, a daily limit, a test call; never a key ── */

const providers = require('../admin/providers');

router.get('/v1/admin/providers', admin, async (_req, res) => {
  await settings.reload();
  res.json({ providers: await providers.list() });
});

router.put('/v1/admin/providers/:name', change, async (req, res) => {
  const reason = reasonOf(req);
  const input = {};
  if (req.body?.off !== undefined) input.off = req.body.off;
  if (req.body?.daily_limit !== undefined) input.daily_limit = req.body.daily_limit === null ? null : Number(req.body.daily_limit);
  if (req.body?.daily_usd !== undefined) input.daily_usd = req.body.daily_usd === null ? null : Number(req.body.daily_usd);
  const value = providers.check(req.params.name, input);
  await settings.set(`provider:${req.params.name}`, value, { wallet: who(req), action: 'provider', reason });
  res.json({ provider: (await providers.list()).find(p => p.name === req.params.name) || { name: req.params.name, ...value } });
});

router.post('/v1/admin/providers/:name/test', change, async (req, res) => {
  const out = await providers.test(req.params.name);
  await settings.note({ wallet: who(req), action: 'provider_test', key: `provider:${req.params.name}`, after: out, reason: 'test call' });
  res.json(out);
});

/* ── the dashboard and health ── */

router.get('/v1/admin/dashboard', admin, async (req, res) => res.json(await require('../admin/dashboard').summary(req.query.days)));
router.get('/v1/admin/health', admin, async (_req, res) => res.json(await require('../admin/health').status()));

/* ── accounts: look up, and the few logged actions ── */

const accounts = require('../admin/accounts');
router.get('/v1/admin/accounts/:q', admin, async (req, res) => res.json(await accounts.lookup(req.params.q)));
router.post('/v1/admin/accounts/:q/credits', change, async (req, res) => res.json(await accounts.addCredits(req.params.q, Number(req.body?.cents), { wallet: who(req), reason: reasonOf(req) })));
router.post('/v1/admin/accounts/:q/refund', change, async (req, res) => res.json(await accounts.refundRun(req.params.q, req.body?.run_id, { wallet: who(req), reason: reasonOf(req) })));
router.post('/v1/admin/accounts/:q/pass', change, async (req, res) => res.json(await accounts.extendPass(req.params.q, Number(req.body?.days), { wallet: who(req), reason: reasonOf(req) })));
router.put('/v1/admin/accounts/:q/blocked', change, async (req, res) => res.json(await accounts.setBlocked(req.params.q, req.body?.blocked, { wallet: who(req), reason: reasonOf(req) })));

/* ── region blocks per trading venue: a country list, never a key or money ── */

const regions = require('../compliance/regions');
router.get('/v1/admin/regions', admin, async (req, res) => { await settings.reload(); res.json(regions.adminList(req)); });
router.put('/v1/admin/regions/:venue', change, async (req, res) => {
  const reason = reasonOf(req);
  await regions.set(req.params.venue, req.body?.default ? null : req.body?.countries, { wallet: who(req), reason });
  res.json(regions.adminList(req));
});

/* ── RektBull Points: the point's value, the rebate, the token wording (never a balance: nothing here moves value) ── */

const rewardPoints = require('../rewards/points');
router.get('/v1/admin/rewards', admin, async (_req, res) => { await settings.reload(); res.json({ ...rewardPoints.config(), defaults: rewardPoints.DEFAULTS, supply: await rewardPoints.supply() }); });
router.put('/v1/admin/rewards', change, async (req, res) => {
  const reason = reasonOf(req);
  const value = req.body?.default ? null : { ...(settings.get('rewards') || {}), ...rewardPoints.checkSettings(req.body || {}) };
  await settings.set('rewards', value, { wallet: who(req), action: value ? 'rewards' : 'rewards_default', reason });
  res.json({ ...rewardPoints.config(), supply: await rewardPoints.supply() });
});

/* ── AI forecasts: switches and numbers (forecasts/settings.js), and a run on demand (it spends AI usage) ── */

const fsettings = require('../forecasts/settings');
router.get('/v1/admin/forecasts', admin, async (_req, res) => { await settings.reload(); res.json({ settings: fsettings.get(), defaults: fsettings.DEFAULTS, track_record: await require('../forecasts/polymarket').trackRecord(), auto: await require('../polymarket/auto').adminSummary(), memes: await require('../memes/signals').trackRecord() }); });
router.put('/v1/admin/forecasts', change, async (req, res) => {
  const reason = reasonOf(req);
  const value = req.body?.default ? null : { ...(settings.get('forecasts') || {}), ...fsettings.check(req.body || {}) };
  await settings.set('forecasts', value, { wallet: who(req), action: value ? 'forecasts' : 'forecasts_default', reason });
  res.json({ settings: fsettings.get() });
});
router.post('/v1/admin/forecasts/run', change, async (req, res) => {
  const reason = reasonOf(req);
  await settings.note({ wallet: who(req), action: 'forecasts_run', key: 'forecasts', reason });
  res.json(await require('../forecasts/polymarket').tick({ force: true }));
});
router.post('/v1/admin/memes/run', change, async (req, res) => {
  const reason = reasonOf(req);
  await settings.note({ wallet: who(req), action: 'memes_run', key: 'forecasts', reason });
  res.json(await require('../memes/signals').tick({ force: true }));
});

/* ── the site banner ── */

const banner = require('../admin/banner');
router.get('/v1/admin/banner', admin, async (_req, res) => { await settings.reload(); res.json({ banner: banner.current() }); });
router.put('/v1/admin/banner', change, async (req, res) => {
  const reason = reasonOf(req);
  const value = req.body?.text ? banner.check(req.body) : null;
  await settings.set('banner', value, { wallet: who(req), action: value ? 'banner' : 'banner_off', reason });
  res.json({ banner: banner.current() });
});

/* ── the tools that were API-only: the airdrop list (logged here) and the crypto checkout invoices ── */

router.get('/v1/admin/tools', admin, async (_req, res) => {
  const db = require('../config/db');
  const [airdrops, invoices] = await Promise.all([
    require('../services/claims').programs({ all: true }),
    db.query(`SELECT h.id, h.amount_cents, h.product, h.status, h.created_at, a.wallet FROM hosted_invoices h JOIN accounts a ON a.id = h.account_id ORDER BY h.created_at DESC LIMIT 50`),
  ]);
  res.json({ airdrops, hosted_invoices: invoices.rows, research_review: '/research#review' });
});

router.put('/v1/admin/tools/airdrops/:id', change, async (req, res) => {
  const reason = reasonOf(req);
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const out = await require('../services/claims').setActive(req.params.id, !!req.body?.active);
  await settings.note({ wallet: who(req), action: out.active ? 'airdrop_on' : 'airdrop_off', key: `airdrop:${req.params.id}`, after: out, reason });
  res.json(out);
});

module.exports = router;

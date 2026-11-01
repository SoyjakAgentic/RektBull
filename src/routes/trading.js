/**
 * Trading endpoints. Everything here is for the signed-in wallet only, and
 * RektBull signs nothing: approve-each trades come back as calls for the
 * user's own wallet to send.
 */
const express = require('express');
const env = require('../config/env');
const { requireAuth } = require('../middleware/auth');
const { TRADE_CHAINS } = require('../trade/chains');
const rules = require('../trade/rules');
const proposals = require('../trade/proposals');
const positions = require('../trade/positions');
const permissions = require('../trade/permissions');

const router = express.Router();

/** A blocked trade answers 422 with the reason, and the risks to acknowledge if any. */
function blocked(res, err) {
  return res.status(422).json({ error: 'trade_blocked', message: err.message, ...(err.needsAcknowledgement ? { needs_acknowledgement: true, risks: err.risks } : {}) });
}
const guard = fn => async (req, res) => {
  try { await fn(req, res); } catch (err) { if (err.isTradeBlocked) return blocked(res, err); throw err; }
};

router.get('/v1/trading/config', (_req, res) => res.json({
  enabled: env.tradingEnabled,
  fee_pct: Math.min(env.swapFeeBps, 100) / 100,
  chains: Object.fromEntries(Object.entries(TRADE_CHAINS).map(([k, c]) => [k, { chain_id: c.chainId, bases: Object.keys(c.bases), default_base: c.defaultBase }])),
  defaults: { ...rules.DEFAULT_SETTINGS, router_limits: { per_trade_usd: 500, per_day_usd: 10000, days: 7 } },
  automatic_trading: { routers: env.tradeRouters, session_key: env.sessionKeyAddress || null, wallet_types: ['metamask'] },
}));

router.get('/v1/trading/settings', requireAuth, async (req, res) => res.json(await rules.settingsFor(req.account.id)));
router.put('/v1/trading/settings', requireAuth, async (req, res) => res.json(await rules.saveSettings(req.account.id, req.body || {})));

router.post('/v1/trading/proposals', requireAuth, guard(async (req, res) => res.status(201).json(await proposals.propose(req.account, req.body || {}))));
router.get('/v1/trading/proposals', requireAuth, async (req, res) => res.json({ proposals: await proposals.list(req.account) }));
router.get('/v1/trading/proposals/:id', requireAuth, async (req, res) => res.json(await proposals.get(req.account, req.params.id)));
router.post('/v1/trading/proposals/:id/approve', requireAuth, guard(async (req, res) => res.json(await proposals.approve(req.account, req.params.id))));
router.post('/v1/trading/proposals/:id/submitted', requireAuth, async (req, res) => res.json(await proposals.submitted(req.account, req.params.id, req.body?.tx_hash)));
router.post('/v1/trading/proposals/:id/cancel', requireAuth, async (req, res) => res.json(await proposals.cancel(req.account, req.params.id)));

/** The signed-in wallet's limits on the Trade Router, read onchain. */
router.get('/v1/trading/limits', requireAuth, async (req, res) => {
  const chainId = Number(req.query.chain_id || 84532);
  const routerAddr = env.tradeRouters[String(chainId)];
  if (!routerAddr || !permissions.CHAIN_NAMES[chainId]) return res.status(404).json({ error: 'not_available', message: `automatic trading isn't available on chain ${chainId}` });
  const iface = new (require('ethers').Interface)(['function limits(address) view returns (uint128 perTradeUsd, uint128 perPeriodUsd, uint32 periodSeconds, uint64 validUntil)']);
  const raw = await require('../providers/rpc').evmRpc(permissions.CHAIN_NAMES[chainId], 'eth_call', [{ to: routerAddr, data: iface.encodeFunctionData('limits', [req.account.wallet]) }, 'latest']);
  const l = iface.decodeFunctionResult('limits', raw);
  const validUntil = Number(l.validUntil);
  res.json({ chain_id: chainId, router: routerAddr, active: validUntil * 1000 > Date.now(), per_trade_usd: Number(l.perTradeUsd) / 1e8, per_day_usd: Number(l.perPeriodUsd) / 1e8, period_seconds: Number(l.periodSeconds), valid_until: validUntil || null });
});

router.get('/v1/trading/positions', requireAuth, async (req, res) => res.json({ positions: await positions.list(req.account.id) }));

router.post('/v1/trading/permissions', requireAuth, async (req, res) => {
  if (!env.sessionKeyAddress) return res.status(503).json({ error: 'not_configured', message: 'Automatic trading is not set up yet (SESSION_KEY_ADDRESS).' });
  res.status(201).json(await permissions.register(req.account, req.body || {}, { sessionKey: env.sessionKeyAddress }));
});
router.get('/v1/trading/permissions', requireAuth, async (req, res) => res.json({ permissions: await permissions.list(req.account) }));
router.post('/v1/trading/permissions/:id/revoke', requireAuth, async (req, res) => res.json(await permissions.revoke(req.account, req.params.id)));

module.exports = router;

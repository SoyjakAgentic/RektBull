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
const networks = require('../trade/networks');
const { evmRpc } = require('../providers/rpc');
const autonomous = require('../trade/autonomous');
const core = require('@metamask/delegation-core');

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
  chains: Object.fromEntries(Object.entries(TRADE_CHAINS).map(([k, c]) => [k, { chain_id: c.chainId, label: c.label, bases: Object.keys(c.bases), default_base: c.defaultBase }])),
  defaults: { ...rules.DEFAULT_SETTINGS, router_limits: { per_trade_usd: 500, per_day_usd: 10000, days: 7 } },
  automatic_trading: {
    session_key: env.sessionKeyAddress || null, wallet_types: ['metamask', 'safe', 'coinbase'],
    networks: Object.fromEntries(networks.chainIds().map(id => { const n = networks.network(id); return [id, { label: n.label, router: n.router, tokens: n.tokens, default_base: n.defaultBase, delegation_manager: n.delegationManager, safe_module: n.safeModule || null, spend_permission_manager: n.spendPermissionManager || null, private_send: !!n.sendRpc }]; })),
  },
}));

router.get('/v1/trading/settings', requireAuth, async (req, res) => res.json(await rules.settingsFor(req.account.id)));
router.put('/v1/trading/settings', requireAuth, async (req, res) => res.json(await rules.saveSettings(req.account.id, req.body || {})));

router.post('/v1/trading/proposals', requireAuth, guard(async (req, res) => res.status(201).json(await proposals.propose(req.account, req.body || {}))));
router.get('/v1/trading/proposals', requireAuth, async (req, res) => res.json({ proposals: await proposals.list(req.account) }));
router.get('/v1/trading/proposals/:id', requireAuth, async (req, res) => res.json(await proposals.get(req.account, req.params.id)));
router.post('/v1/trading/proposals/:id/approve', requireAuth, guard(async (req, res) => res.json(await proposals.approve(req.account, req.params.id))));
router.post('/v1/trading/proposals/:id/submitted', requireAuth, async (req, res) => res.json(await proposals.submitted(req.account, req.params.id, req.body?.tx_hash)));
router.post('/v1/trading/proposals/:id/cancel', requireAuth, async (req, res) => res.json(await proposals.cancel(req.account, req.params.id)));

/** The signed-in wallet's limits on the Trade Router, and whether it's a MetaMask smart account, read onchain. */
router.get('/v1/trading/limits', requireAuth, async (req, res) => {
  const net = networks.network(Number(req.query.chain_id || 84532));
  const raw = await evmRpc(net.name, 'eth_call', [{ to: net.router, data: permissions.ROUTER.encodeFunctionData('limits', [req.account.wallet]) }, 'latest']);
  const l = permissions.ROUTER.decodeFunctionResult('limits', raw);
  const code = String(await evmRpc(net.name, 'eth_getCode', [req.account.wallet, 'latest'])).toLowerCase();
  const validUntil = Number(l.validUntil);
  res.json({
    chain_id: net.chainId, router: net.router, active: validUntil * 1000 > Date.now(),
    per_trade_usd: Number(l.perTradeUsd) / 1e8, per_day_usd: Number(l.perPeriodUsd) / 1e8, period_seconds: Number(l.periodSeconds), valid_until: validUntil || null,
    smart_account: code === ('0xef0100' + net.delegatorImpl.slice(2)).toLowerCase(),
  });
});

router.get('/v1/trading/positions', requireAuth, async (req, res) => res.json({ positions: await positions.list(req.account.id) }));

/**
 * The exact delegation for the signed-in wallet to sign: RektBull's four
 * caveats, expiring with the wallet's router limits (at most 30 days). The
 * wallet shows it and signs it as EIP-712 typed data; POST it back to
 * /v1/trading/permissions with the signature.
 */
router.get('/v1/trading/auto/delegation', requireAuth, async (req, res) => {
  if (!env.sessionKeyAddress) return res.status(503).json({ error: 'not_configured', message: 'Automatic trading is not set up yet (SESSION_KEY_ADDRESS).' });
  const net = networks.network(Number(req.query.chain_id || 84532));
  const raw = await evmRpc(net.name, 'eth_call', [{ to: net.router, data: permissions.ROUTER.encodeFunctionData('limits', [req.account.wallet]) }, 'latest']);
  const validUntil = Number(permissions.ROUTER.decodeFunctionResult('limits', raw).validUntil);
  const now = Math.floor(Date.now() / 1000);
  if (!(validUntil > now)) return res.status(422).json({ error: 'limits_not_set', message: 'Set your trading limits on the router first.' });
  const expiry = Math.min(validUntil, now + 30 * 86400);
  const caveats = [
    { enforcer: net.mm.RedeemerEnforcer, terms: core.createRedeemerTerms({ redeemers: [env.sessionKeyAddress] }), args: '0x' },
    { enforcer: net.mm.TimestampEnforcer, terms: core.createTimestampTerms({ afterThreshold: 0, beforeThreshold: expiry }), args: '0x' },
    { enforcer: net.mm.AllowedTargetsEnforcer, terms: core.createAllowedTargetsTerms({ targets: [net.router] }), args: '0x' },
    { enforcer: net.mm.AllowedMethodsEnforcer, terms: core.createAllowedMethodsTerms({ selectors: [permissions.SWAP_SELECTOR] }), args: '0x' },
  ];
  const salt = BigInt('0x' + require('crypto').randomBytes(16).toString('hex')).toString();
  const message = { delegate: env.sessionKeyAddress, delegator: req.account.wallet, authority: core.ROOT_AUTHORITY, caveats: caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms })), salt };
  res.json({
    chain_id: net.chainId, expires_at: expiry,
    typed_data: { domain: { name: 'DelegationManager', version: '1', chainId: net.chainId, verifyingContract: net.delegationManager }, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...permissions.TYPES }, primaryType: 'Delegation', message },
    delegation: { ...message, caveats },
  });
});

/** The approvals the router needs for automatic trading: each router token, enough for the user's limits. */
router.get('/v1/trading/auto/allowances', requireAuth, async (req, res) => {
  const net = networks.network(Number(req.query.chain_id || 84532));
  const raw = await evmRpc(net.name, 'eth_call', [{ to: net.router, data: permissions.ROUTER.encodeFunctionData('limits', [req.account.wallet]) }, 'latest']);
  const l = permissions.ROUTER.decodeFunctionResult('limits', raw);
  const days = Math.max(1, Math.ceil((Number(l.validUntil) * 1000 - Date.now()) / 86400000));
  const usd = BigInt(l.perPeriodUsd) * BigInt(days);
  const venues = require('../trade/venues');
  const tokens = [];
  for (const [symbol, t] of Object.entries(net.tokens)) {
    let amount = null;
    try { amount = usd > 0n ? (await venues.view(net, 'amountForUsd', [t.address, usd])).toString() : null; } catch { /* no price right now */ }
    tokens.push({ symbol, address: t.address, decimals: t.decimals, amount });
  }
  res.json({ chain_id: net.chainId, router: net.router, covers_usd: Number(usd) / 1e8, tokens });
});

/**
 * The setup transactions a Safe or a Coinbase Smart Wallet sends from itself
 * before RektBull can trade for it (the wallet shows and signs each one):
 *   safe:     enable the RektBull module, approve the router for each token,
 *             set limits on the router, name RektBull's key on the module;
 *   coinbase: set limits on the router, name RektBull's key as operator, and
 *             grant Coinbase spend permissions to the router (never to RektBull).
 * Then POST /v1/trading/permissions with wallet_type and, for Coinbase, the
 * spend_permissions returned here.
 */
router.get('/v1/trading/auto/setup', requireAuth, async (req, res) => {
  if (!env.sessionKeyAddress) return res.status(503).json({ error: 'not_configured', message: 'Automatic trading is not set up yet (SESSION_KEY_ADDRESS).' });
  const net = networks.network(Number(req.query.chain_id || 84532));
  const type = req.query.wallet_type;
  const perTrade = Number(req.query.per_trade_usd || 500);
  const perDay = Number(req.query.per_day_usd || 10000);
  const days = Math.min(30, Math.max(1, Number(req.query.days || 7)));
  if (!(perTrade > 0 && perDay >= perTrade)) return res.status(400).json({ error: 'bad_request', message: 'per_day_usd must be at least per_trade_usd, and both above 0' });
  const validUntil = Math.floor(Date.now() / 1000) + days * 86400;
  const { ethers } = require('ethers');
  const R = new ethers.Interface(['function setLimits(uint128,uint128,uint32,uint64)', 'function setOperator(address)']);
  const ERC20 = new ethers.Interface(['function approve(address,uint256)']);
  const limits = { to: net.router, data: R.encodeFunctionData('setLimits', [BigInt(Math.round(perTrade * 1e8)), BigInt(Math.round(perDay * 1e8)), 86400, validUntil]), step: 'Set your limits on the Trade Router' };
  const venues = require('../trade/venues');
  const sized = async t => (await venues.view(net, 'amountForUsd', [t.address, BigInt(Math.round(perDay * days * 1e8))]));
  if (type === 'safe') {
    if (!net.safeModule) return res.status(422).json({ error: 'not_available', message: 'Safe trading isn\'t available on this network yet' });
    const safe = String(req.query.safe || '');
    if (!ethers.isAddress(safe)) return res.status(400).json({ error: 'bad_request', message: 'safe must be your Safe\'s address' });
    const M = new ethers.Interface(['function setSession(address,uint64)']);
    const S = new ethers.Interface(['function enableModule(address)']);
    const calls = [{ to: safe, data: S.encodeFunctionData('enableModule', [net.safeModule]), step: 'Enable the RektBull Safe Module' }];
    for (const [symbol, t] of Object.entries(net.tokens)) calls.push({ to: t.address, data: ERC20.encodeFunctionData('approve', [net.router, await sized(t)]), step: `Let the router trade ${symbol}` });
    calls.push(limits, { to: net.safeModule, data: M.encodeFunctionData('setSession', [env.sessionKeyAddress, validUntil]), step: 'Name RektBull\'s key on the module, until your limits expire' });
    return res.json({ chain_id: net.chainId, wallet_type: 'safe', safe, calls: calls.map(c => ({ ...c, value: '0x0' })) });
  }
  if (type === 'coinbase') {
    if (!net.spendPermissionManager) return res.status(422).json({ error: 'not_available', message: 'Coinbase Smart Wallet trading isn\'t available on this network yet' });
    const PERM = '(address account, address spender, address token, uint160 allowance, uint48 period, uint48 start, uint48 end, uint256 salt, bytes extraData)';
    const SPM = new ethers.Interface([`function approve(${PERM} spendPermission) returns (bool)`]);
    // A little in the past: block times trail the wall clock, and a permission that hasn't started yet refuses every spend.
    const start = Math.floor(Date.now() / 1000) - 300;
    const spendPermissions = [];
    for (const t of Object.values(net.tokens)) {
      spendPermissions.push({ account: req.account.wallet, spender: net.router, token: t.address, allowance: (await venues.view(net, 'amountForUsd', [t.address, BigInt(Math.round(perDay * 1e8))])).toString(), period: 86400, start, end: validUntil, salt: BigInt('0x' + require('crypto').randomBytes(16).toString('hex')).toString(), extraData: '0x' });
    }
    const calls = [limits, { to: net.router, data: R.encodeFunctionData('setOperator', [env.sessionKeyAddress]), step: 'Name RektBull\'s key as your operator on the router' }];
    for (const sp of spendPermissions) {
      const symbol = networks.routerToken(net, sp.token)?.symbol;
      calls.push({ to: net.spendPermissionManager, data: SPM.encodeFunctionData('approve', [[sp.account, sp.spender, sp.token, BigInt(sp.allowance), sp.period, sp.start, sp.end, BigInt(sp.salt), sp.extraData]]), step: `Let the router spend up to your daily limit of ${symbol} through Coinbase (it sends the result straight back)` });
    }
    return res.json({ chain_id: net.chainId, wallet_type: 'coinbase', calls: calls.map(c => ({ ...c, value: '0x0' })), spend_permissions: spendPermissions,
      note: 'Coinbase\'s Spend Permission Manager must be an owner of your Coinbase Smart Wallet (Coinbase adds it when you first use spend permissions).' });
  }
  res.status(400).json({ error: 'bad_request', message: 'wallet_type must be safe or coinbase (MetaMask uses /v1/trading/auto/delegation)' });
});

router.post('/v1/trading/auto/intents', requireAuth, async (req, res) => res.status(201).json(await autonomous.queue(req.account, req.body || {})));
router.get('/v1/trading/auto/intents', requireAuth, async (req, res) => res.json({ intents: await autonomous.list(req.account) }));
router.post('/v1/trading/auto/intents/:id/cancel', requireAuth, async (req, res) => res.json(await autonomous.cancel(req.account, req.params.id)));

router.post('/v1/trading/permissions', requireAuth, async (req, res) => {
  if (!env.sessionKeyAddress) return res.status(503).json({ error: 'not_configured', message: 'Automatic trading is not set up yet (SESSION_KEY_ADDRESS).' });
  res.status(201).json(await permissions.register(req.account, req.body || {}, { sessionKey: env.sessionKeyAddress }));
});
router.get('/v1/trading/permissions', requireAuth, async (req, res) => res.json({ permissions: await permissions.list(req.account) }));
router.post('/v1/trading/permissions/:id/revoke', requireAuth, async (req, res) => res.json(await permissions.revoke(req.account, req.params.id)));

module.exports = router;

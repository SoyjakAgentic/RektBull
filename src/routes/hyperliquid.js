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
const H = require('../../public/hl-core.js');
const regions = require('../compliance/regions');
const auto = require('../hyperliquid/auto');

const router = express.Router();

/** The manual agent: the name the page approves its browser key under, and for how long. */
const WEB_AGENT = { name: 'rektbull-web', days: 30, max_days: 180 };
const APPS = { mainnet: 'https://app.hyperliquid.xyz', testnet: 'https://app.hyperliquid-testnet.xyz' };

const refusal = fn => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof relay.RelayRefused || err instanceof regions.RegionBlocked || err instanceof auto.AutoRefused) return res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra || {}) });
    if (err.isHyperliquid || err.isProviderLimit) return res.status(err.status || 503).json({ error: 'hyperliquid_unavailable', message: err.isProviderLimit ? `Hyperliquid couldn't be reached: ${err.message}.` : err.message });
    throw err;
  }
};

/** A builder needs at least this much in its own Hyperliquid perps account before it can collect (Hyperliquid's builder-codes page). */
const BUILDER_MIN_ACCOUNT_USD = 100;
function builderConfig() {
  const b = relay.builder();
  if (!b) return { address: null, fee_tenths_bps: 0, fee_pct: 0, note: 'No builder address is set (HL_BUILDER_ADDRESS), so orders are sent with no builder field and RektBull takes no fee on them.' };
  return {
    address: b.b, fee_tenths_bps: b.f, fee_pct: b.f / 1000, max_fee_rate: H.feeRate(b.f),
    note: `RektBull's fee is ${H.feeRate(b.f)} of each fill, taken by Hyperliquid when an order fills and never otherwise. You approve it once, as a most-per-fill rate; it isn't a token approval and can't be raised without a new signature from your wallet.`,
    builder_min_account_usd: BUILDER_MIN_ACCOUNT_USD,
  };
}

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
    // The fee: a Hyperliquid builder code. Hyperliquid takes it on fills only, from the user's account, up to the rate the user approved.
    builder: builderConfig(),
  };
}
router.get('/v1/hyperliquid/config', (req, res) => {
  const r = regions.blockedFor(req, 'hyperliquid');
  res.json({ ...config(), region: { blocked: r.blocked, country: r.country, message: r.reason } });
});

const ZERO = '0x0000000000000000000000000000000000000000';
/**
 * What a region block stops: anything that can open or add to a position
 * (an order that isn't reduce-only, a leverage or margin change) and new
 * approvals. Never cancels, reduce-only orders or taking an approval away,
 * so a user can always get out. Taking an approval away is a fee approval of
 * 0%, or the page's "end the key" (an agent under the same name, whose key
 * the browser threw away, for a day at most: perps.js revokeAgent). Orders
 * from any agent still pass this relay, which refuses the ones that open.
 */
function regionMatters({ type, opens, payload }, now = Date.now()) {
  const a = payload.action;
  if (type === 'approveAgent') {
    if (a.agentAddress.toLowerCase() === ZERO) return false;
    const until = / valid_until (\d+)$/.exec(a.agentName);
    return !(until && Number(until[1]) <= now + 86400000 + 60000);
  }
  if (type === 'approveBuilderFee') return Number(String(a.maxFeeRate).replace('%', '')) > 0;
  return opens || type === 'updateLeverage' || type === 'updateIsolatedMargin';
}

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
  res.json(await relay.send(req.body, {
    wallet: req.account.wallet,
    before: checked => {
      // RektBull's own agent is approved only through /auto/grant, so its limits are always recorded with it.
      const a = checked.payload.action;
      if (a.type === 'approveAgent' && (a.agentAddress.toLowerCase() === env.hlAgentAddress || a.agentName.startsWith(auto.AGENT_NAME))) {
        throw new relay.RelayRefused('RektBull\'s automatic-trading agent is approved from the Automatic trading section, with your limits.', 422, 'use_auto_grant');
      }
      if (regionMatters(checked)) regions.refuseIfBlocked(req, 'hyperliquid');
    },
  }));
}));

/* ── automatic trading (hyperliquid/auto.js): RektBull's agent, the user's limits, enforced by the trade service ── */

router.get('/v1/hyperliquid/auto', requireEvmWallet, refusal(async (req, res) => res.json(await auto.overview(req.account))));

router.post('/v1/hyperliquid/auto/grant', requireEvmWallet, refusal(async (req, res) => {
  res.status(201).json(await auto.grant(req.account, req.body, { before: () => regions.refuseIfBlocked(req, 'hyperliquid') }));
}));

router.post('/v1/hyperliquid/auto/revoke', requireEvmWallet, refusal(async (req, res) => res.json(await auto.revoke(req.account, req.body || {}))));

router.post('/v1/hyperliquid/auto/intents', requireEvmWallet, refusal(async (req, res) => {
  if (req.body?.side !== 'close') regions.refuseIfBlocked(req, 'hyperliquid');
  res.status(201).json(await auto.queue(req.account, req.body || {}));
}));

router.delete('/v1/hyperliquid/auto/intents/:id', requireEvmWallet, refusal(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  res.json(await auto.cancel(req.account, req.params.id));
}));

module.exports = router;
module.exports.config = config;
module.exports.WEB_AGENT = WEB_AGENT;
module.exports.regionMatters = regionMatters;

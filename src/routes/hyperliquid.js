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
const protect = require('../hyperliquid/protect');
const entries = require('../hyperliquid/entries');
const copy = require('../hyperliquid/copy');
const services = require('../admin/services');

const router = express.Router();

/** The manual agent: the name the page approves its browser key under, and for how long. */
const WEB_AGENT = { name: 'rektbull-web', days: 30, max_days: 180 };
const APPS = { mainnet: 'https://app.hyperliquid.xyz', testnet: 'https://app.hyperliquid-testnet.xyz' };

const refusal = fn => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof relay.RelayRefused || err instanceof regions.RegionBlocked || err instanceof auto.AutoRefused || err instanceof entries.EntryRefused || err instanceof copy.CopyRefused) return res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra || {}) });
    if (err.isHyperliquid || err.isProviderLimit) return res.status(err.status || 503).json({ error: 'hyperliquid_unavailable', message: err.isProviderLimit ? `Hyperliquid couldn't be reached: ${err.message}.` : err.message });
    throw err;
  }
};

/** A builder needs at least this much in its own Hyperliquid perps account before it can collect (Hyperliquid's builder-codes page). */
const BUILDER_MIN_ACCOUNT_USD = 100;
function builderConfig() {
  const b = relay.builder();
  if (!b) return { address: null, fee_tenths_bps: 0, fee_pct: 0, note: 'No builder address is set (HL_BUILDER_ADDRESS), so orders are sent with no builder field and RektBull takes no fee on them.' };
  const pf = protect.proposalBuilder().f;
  return {
    address: b.b, fee_tenths_bps: b.f, fee_pct: b.f / 1000, max_fee_rate: H.feeRate(b.f),
    // Orders from a RektBull proposal (a stop-loss, reducing by half) carry this instead: hyperliquid/protect.js.
    proposal_fee_tenths_bps: pf, proposal_fee_rate: H.feeRate(pf),
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
  // fresh=1 right after the page sends an approval, so it sees what it just approved.
  res.json(await markets.approvals(req.account.wallet, req.query.fresh ? { ms: 0 } : {}));
}));

/** A signed action, passed on to Hyperliquid. With proposal_id: an order from a RektBull proposal, which may carry the proposal fee. */
router.post('/v1/hyperliquid/exchange', requireEvmWallet, refusal(async (req, res) => {
  let proposal = null;
  if (req.body?.proposal_id !== undefined) {
    proposal = await protect.live(req.account.id, req.body.proposal_id);
    if (!proposal) throw new relay.RelayRefused('This proposal has expired or was already used. Proposals are good for 10 minutes: refresh for one made from the prices now.', 409, 'proposal_expired');
  }
  const out = await relay.send(req.body, {
    wallet: req.account.wallet,
    proposal,
    before: checked => {
      // RektBull's own agent is approved only through /auto/grant, so its limits are always recorded with it.
      const a = checked.payload.action;
      if (a.type === 'approveAgent' && (a.agentAddress.toLowerCase() === env.hlAgentAddress || a.agentName.startsWith(auto.AGENT_NAME))) {
        throw new relay.RelayRefused('RektBull\'s automatic-trading agent is approved from the Automatic trading section, with your limits.', 422, 'use_auto_grant');
      }
      if (regionMatters(checked)) {
        regions.refuseIfBlocked(req, 'hyperliquid');
        return require('../admin/services').refuseIfPaused('perps'); // paused: nothing new opens; closing still works
      }
    },
  });
  if (proposal) await protect.acted(proposal.id);
  // RektBull Points: a rebate of the builder fee on what filled (Hyperliquid's own answer, not the page's).
  const b = req.body?.action?.builder;
  const filledUsd = (out.results || []).filter(r => r.filled).reduce((s, r) => s + r.size * r.avg_px, 0);
  if (out.type === 'order' && b && filledUsd > 0) {
    await require('../rewards/points').safeCredit({ accountId: req.account.id, source: 'perps', ref: `${req.account.id}:${req.body.nonce}`, feeUsd: filledUsd * b.f / 100000 });
  }
  res.json(out);
}));

/* ── protecting positions and market alerts (hyperliquid/protect.js): rules, not predictions ── */

/** The signed-in wallet's open positions, each checked by the stated rules, with any fix ready to sign. */
router.get('/v1/hyperliquid/protect', requireEvmWallet, refusal(async (req, res) => {
  res.json(await protect.save(req.account, await protect.review(req.account.wallet)));
}));

/** What's happening in the deep markets: extreme funding, mark and oracle apart, open interest building or flushing. */
router.get('/v1/hyperliquid/alerts', refusal(async (_req, res) => {
  res.set('cache-control', 'public, max-age=30');
  res.json(await protect.marketAlerts());
}));

/* ── entry proposals (hyperliquid/entries.js): stated rules, scored in public; offered once switched on ── */

/** The public scorecard, the mode (off, shadow or offered), and the signals open to act on while offered. */
router.get('/v1/hyperliquid/entries', refusal(async (_req, res) => {
  const record = await entries.trackRecord();
  res.set('cache-control', 'public, max-age=60');
  res.json({ ...record, open: record.mode === 'offered' ? await entries.actionable() : [] });
}));

/** One signal's bracket, sized for the signed-in account and saved as its proposal for 2 minutes. It opens a position, so region blocks and a paused Perps desk refuse it. */
router.post('/v1/hyperliquid/entries/:id/bracket', requireEvmWallet, refusal(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  regions.refuseIfBlocked(req, 'hyperliquid');
  await require('../admin/services').refuseIfPaused('perps');
  res.status(201).json(await entries.bracketFor(req.account, req.params.id));
}));

/* ── automatic trading (hyperliquid/auto.js): RektBull's agent, the user's limits, enforced by the trade service ── */

// Each visit records where the user is: automatic opens stop while that's a blocked place (hyperliquid/auto.js).
router.get('/v1/hyperliquid/auto', requireEvmWallet, refusal(async (req, res) => res.json(await auto.overview(req.account, { place: regions.placeOf(req) }))));

router.post('/v1/hyperliquid/auto/grant', requireEvmWallet, require('../admin/services').gate('perps'), refusal(async (req, res) => {
  res.status(201).json(await auto.grant(req.account, req.body, { before: () => regions.refuseAutoIfBlocked(req, 'hyperliquid'), place: regions.placeOf(req) }));
}));

router.post('/v1/hyperliquid/auto/revoke', requireEvmWallet, refusal(async (req, res) => res.json(await auto.revoke(req.account, req.body || {}))));

router.post('/v1/hyperliquid/auto/intents', requireEvmWallet, require('../admin/services').gate('perps', req => req.body?.side === 'close'), refusal(async (req, res) => {
  if (req.body?.side !== 'close') regions.refuseAutoIfBlocked(req, 'hyperliquid'); // RektBull's servers send it
  res.status(201).json(await auto.queue(req.account, req.body || {}));
}));

router.delete('/v1/hyperliquid/auto/intents/:id', requireEvmWallet, refusal(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  res.json(await auto.cancel(req.account, req.params.id));
}));

/* ── copy trading (hyperliquid/copy.js): automatic trading that follows a trader the user chose ── */

router.get('/v1/hyperliquid/copy', requireEvmWallet, refusal(async (req, res) => res.json(await copy.overview(req.account))));

/** A trader's results and positions, from Hyperliquid's own figures: open to every signed-in wallet, like any read. */
router.get('/v1/hyperliquid/copy/traders/:address', requireEvmWallet, refusal(async (req, res) => res.json(await copy.traderProfile(req.params.address))));

router.post('/v1/hyperliquid/copy/follows', requireEvmWallet, services.gate('perps'), services.gate('perps_copy'), refusal(async (req, res) => {
  res.status(201).json(await copy.follow(req.account, req.body || {}, { before: () => regions.refuseAutoIfBlocked(req, 'hyperliquid') }));
}));

/** Stopping is a way out: never refused by a pause or a region. */
router.post('/v1/hyperliquid/copy/follows/:id/stop', requireEvmWallet, refusal(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  res.json(await copy.stop(req.account, req.params.id, { close: req.body?.close_positions === true }));
}));

module.exports = router;
module.exports.config = config;
module.exports.WEB_AGENT = WEB_AGENT;
module.exports.regionMatters = regionMatters;

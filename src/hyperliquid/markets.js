/**
 * What the Perps page shows, read from Hyperliquid's info API: the markets
 * (price, funding, open interest, volume), and one account's margin,
 * positions and open orders. Viewing is never blocked by region and needs no
 * approval: it's public data.
 *
 * Every answer names its source, and a part that couldn't be read says why
 * instead of being left out or guessed.
 */
const env = require('../config/env');
const hl = require('../providers/hyperliquid');

const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
const isAddress = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));

/**
 * Why RektBull's automatic trading won't open a position in this market, or
 * null when it may. A thin market is where a stolen agent key could trade a
 * user's margin away to an accomplice, so automatic trading keeps to deep ones.
 */
function autoRefusal(m) {
  if (m.delisted) return 'delisted';
  if (m.only_isolated) return 'isolated-only market';
  if (!(m.open_interest_usd >= env.hlAutoMinOpenInterestUsd)) return `open interest under $${env.hlAutoMinOpenInterestUsd.toLocaleString('en-US')}`;
  if (!(m.day_volume_usd >= env.hlAutoMinDayVolumeUsd)) return `24-hour volume under $${env.hlAutoMinDayVolumeUsd.toLocaleString('en-US')}`;
  return null;
}

function shape([meta, ctxs]) {
  if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs)) throw new hl.HyperliquidError('Hyperliquid\'s market list came back in a shape RektBull doesn\'t know');
  return meta.universe.map((u, i) => {
    const c = ctxs[i] || {};
    const mark = num(c.markPx);
    const prev = num(c.prevDayPx);
    const m = {
      asset: i, coin: u.name, sz_decimals: u.szDecimals, max_leverage: u.maxLeverage, only_isolated: !!u.onlyIsolated, delisted: !!u.isDelisted,
      mark_px: mark, oracle_px: num(c.oraclePx), mid_px: num(c.midPx), prev_day_px: prev,
      change_24h_pct: mark && prev ? Math.round((mark - prev) / prev * 10000) / 100 : null,
      funding_hourly_pct: c.funding === undefined ? null : Number(c.funding) * 100,
      open_interest: num(c.openInterest), open_interest_usd: mark !== null && c.openInterest !== undefined ? Math.round(Number(c.openInterest) * mark) : null,
      day_volume_usd: c.dayNtlVlm === undefined ? null : Math.round(Number(c.dayNtlVlm)),
    };
    const refusal = autoRefusal(m);
    return { ...m, auto: refusal === null, ...(refusal ? { auto_refusal: refusal } : {}) };
  });
}

/** Every perp market on Hyperliquid's first perp dex, with its asset id (its index, as orders name it). */
async function markets({ ms = 3000 } = {}) {
  return shape(await hl.info({ type: 'metaAndAssetCtxs' }, { ms }));
}
async function market(coin, opts) {
  const m = (await markets(opts)).find(x => x.coin === coin);
  if (!m) throw Object.assign(new Error(`Hyperliquid has no perp market called ${coin}`), { status: 404 });
  return m;
}

function position(p) {
  const x = p.position;
  const size = Number(x.szi);
  return {
    coin: x.coin, side: size >= 0 ? 'long' : 'short', size: Math.abs(size), signed_size: x.szi, entry_px: num(x.entryPx), value_usd: num(x.positionValue),
    unrealized_pnl_usd: num(x.unrealizedPnl), return_on_equity_pct: x.returnOnEquity === undefined ? null : Math.round(Number(x.returnOnEquity) * 10000) / 100,
    liquidation_px: num(x.liquidationPx), margin_used_usd: num(x.marginUsed),
    leverage: x.leverage?.value ?? null, margin_mode: x.leverage?.type ?? null, max_leverage: x.maxLeverage ?? null,
    funding_since_open_usd: num(x.cumFunding?.sinceOpen),
  };
}
const order = o => ({
  coin: o.coin, oid: o.oid, side: o.side === 'B' ? 'buy' : 'sell', px: num(o.limitPx), size: num(o.sz), original_size: num(o.origSz),
  type: o.orderType || 'Limit', tif: o.tif || null, reduce_only: !!o.reduceOnly, trigger: !!o.isTrigger, trigger_px: o.isTrigger ? num(o.triggerPx) : null,
  trigger_condition: o.isTrigger ? o.triggerCondition : null, position_tpsl: !!o.isPositionTpsl, placed_at: o.timestamp,
});

/** One part of an answer: its value, or why it couldn't be read. */
async function part(fn) {
  try { return { ok: true, value: await fn() }; } catch (err) { return { ok: false, error: err.message }; }
}

/**
 * An account's margin, positions and open orders. `user` is the account's own
 * address (never an agent's: Hyperliquid answers empty for those).
 */
async function account(user, { ms = 4000 } = {}) {
  if (!isAddress(user)) throw Object.assign(new Error('user must be a wallet address (0x and 40 hex characters)'), { status: 400 });
  user = user.toLowerCase();
  const [state, orders] = await Promise.all([
    part(() => hl.info({ type: 'clearinghouseState', user }, { ms })),
    part(() => hl.info({ type: 'frontendOpenOrders', user }, { ms: ms && Math.max(ms, 8000) })),
  ]);
  const out = { user, network: hl.network(), source: hl.SOURCE };
  if (state.ok) {
    const s = state.value;
    Object.assign(out, {
      account_value_usd: num(s.marginSummary?.accountValue), margin_used_usd: num(s.marginSummary?.totalMarginUsed), position_value_usd: num(s.marginSummary?.totalNtlPos),
      withdrawable_usd: num(s.withdrawable), maintenance_margin_usd: num(s.crossMaintenanceMarginUsed),
      positions: (s.assetPositions || []).map(position), as_of: s.time || null,
    });
  } else out.positions_error = `Positions and margin couldn't be read: ${state.error}`;
  if (orders.ok) out.open_orders = (orders.value || []).map(order);
  else out.open_orders_error = `Open orders couldn't be read: ${orders.error}`;
  return out;
}

/**
 * What the account has approved: its agent wallets (name, address, expiry)
 * and the most RektBull's builder address may charge on a fill.
 */
async function approvals(user, { ms = 5000 } = {}) {
  if (!isAddress(user)) throw Object.assign(new Error('user must be a wallet address (0x and 40 hex characters)'), { status: 400 });
  user = user.toLowerCase();
  const builder = env.hlBuilderAddress;
  const [agents, fee] = await Promise.all([
    part(() => hl.info({ type: 'extraAgents', user }, { ms })),
    builder ? part(() => hl.info({ type: 'maxBuilderFee', user, builder }, { ms })) : null,
  ]);
  const out = { user, network: hl.network(), source: hl.SOURCE };
  if (agents.ok) out.agents = (agents.value || []).map(a => ({ name: a.name, address: String(a.address).toLowerCase(), valid_until: a.validUntil ?? null }));
  else out.agents_error = `Approved agents couldn't be read: ${agents.error}`;
  if (!builder) out.builder_fee = { set: false, note: 'RektBull has no builder address set, so orders carry no RektBull fee.' };
  else if (fee.ok) {
    const approved = Number(fee.value) || 0;
    const proposal = Math.max(env.hlProposalFeeTenthsBps, env.hlBuilderFeeTenthsBps);
    out.builder_fee = { set: true, builder, approved_tenths_bps: approved, needed_tenths_bps: env.hlBuilderFeeTenthsBps, approved: approved >= env.hlBuilderFeeTenthsBps, proposal_tenths_bps: proposal, proposal_approved: approved >= proposal };
  }
  else out.builder_fee = { set: true, builder, error: `The builder fee approval couldn't be read: ${fee.error}` };
  return out;
}

module.exports = { markets, market, account, approvals, shape, position, order, autoRefusal, isAddress };

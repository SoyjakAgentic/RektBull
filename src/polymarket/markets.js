/**
 * Polymarket events and markets as RektBull shows them: prices, volume,
 * liquidity, end dates, and a resolution-risk note per market. Every figure
 * is Polymarket's own, named with its source; nothing is estimated here.
 *
 * Which id an order uses (docs: market-data/market-details, trading/place-orders):
 * a market whose `version` is "v2" trades its `positionIds`; any other (CTF)
 * market trades its `clobTokenIds`.
 */
const pm = require('../providers/polymarket');

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const list = v => { if (Array.isArray(v)) return v; try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } };

/** The ids orders are signed with, in outcome order, or [] when Polymarket hasn't published them. */
function assetIds(m) {
  return (m.version === 'v2' ? list(m.positionIds) : list(m.clobTokenIds)).map(String);
}

/**
 * What to know about how this market resolves, from Polymarket's own fields
 * (and, when given, its /v2/resolutions row). Each line that couldn't be
 * read says so; `flags` are the reasons for care.
 */
function resolutionNote(m, state = undefined) {
  const flags = [];
  const history = list(m.umaResolutionStatuses).map(String);
  const status = state?.status || m.umaResolutionStatus || null;
  const disputed = state ? !!state.was_disputed : history.includes('disputed') || history.includes('challenged') || ['disputed', 'challenged'].includes(status);
  const end = m.endDate ? new Date(m.endDate) : null;
  const ended = end && !Number.isNaN(end.getTime()) && end.getTime() < Date.now();
  const src = String(m.resolutionSource || '').trim();
  if (disputed) flags.push('The proposed result was disputed: resolution can take 4 to 6 days and may not match the price.');
  else if (['proposed', 'reproposed'].includes(status)) flags.push('A result has been proposed and is in its challenge period: it can still be disputed.');
  if (ended && !m.closed && status !== 'resolved') flags.push('The end date has passed and the market is not resolved yet.');
  if (!src) flags.push('Polymarket names no resolution source link for this market: read its rules.');
  if (m.negRiskOther) flags.push('This is the "Other" outcome of a negative-risk event: its meaning changes as outcomes are named. Polymarket advises against trading it directly.');
  return {
    resolution_source: src || null,
    resolution_source_note: src ? null : 'not given by Polymarket for this market; the rules in its description decide',
    end_date: m.endDate || null,
    end_date_note: m.endDate ? 'when the market becomes eligible to resolve, not a payout date' : 'not given by Polymarket',
    mechanism: m.resolutionMechanism || null,
    oracle: m.resolutionMechanism === 'oracle' || m.umaBond ? 'UMA Optimistic Oracle (propose, 2-hour challenge period, dispute, UMA vote)' : null,
    uma_status: status,
    uma_status_note: status ? null : 'no resolution request yet, or Polymarket did not report one',
    disputed,
    resolved: !!m.closed && (status === 'resolved' || !status),
    proposer_bond_usd: num(m.umaBond),
    flags,
    source: state ? `${pm.SOURCES.gamma}; ${pm.SOURCES.data} /v2/resolutions` : pm.SOURCES.gamma,
    rules: 'The market title is the question; the rules in the description define how it resolves.',
  };
}

/** One market. `state` is its /v2/resolutions row when the caller read it (null: Polymarket has none). */
function presentMarket(m, { state, full = false } = {}) {
  const names = list(m.outcomes); const prices = list(m.outcomePrices); const ids = assetIds(m);
  const fee = m.feesEnabled && m.feeSchedule ? { rate: num(m.feeSchedule.rate), exponent: num(m.feeSchedule.exponent), taker_only: !!m.feeSchedule.takerOnly } : null;
  return {
    id: String(m.id), slug: m.slug, question: m.question, title: m.groupItemTitle || null, condition_id: m.conditionId, image: m.icon || m.image || null,
    position_system: m.version === 'v2' ? 'v2' : 'ctf', neg_risk: !!m.negRisk,
    outcomes: names.map((name, i) => ({ name, price: num(prices[i]), asset_id: ids[i] || null })),
    best_bid: num(m.bestBid), best_ask: num(m.bestAsk), last_trade_price: num(m.lastTradePrice), spread: num(m.spread),
    volume_usd: num(m.volumeNum ?? m.volume), volume_24h_usd: num(m.volume24hr), liquidity_usd: num(m.liquidityNum ?? m.liquidity),
    end_date: m.endDate || null, active: !!m.active, closed: !!m.closed, accepting_orders: !!m.acceptingOrders && !m.closed,
    tick_size: num(m.orderPriceMinTickSize), min_order_size: num(m.orderMinSize), seconds_delay: num(m.secondsDelay) || 0,
    restricted: !!m.restricted,
    // Polymarket's own taker fee: fee = shares × rate × price × (1 − price). RektBull's builder fee is added on top (routes: /config).
    platform_fee: fee, platform_fee_note: fee ? 'Polymarket\'s taker fee: shares × rate × price × (1 − price). Makers pay none.' : 'Polymarket charges no fee on this market.',
    resolution: resolutionNote(m, state),
    ...(full ? { description: m.description || null } : {}),
    url: m.slug ? `https://polymarket.com/market/${m.slug}` : null,
  };
}

function presentEvent(e, opts = {}) {
  const markets = (e.markets || []).filter(m => m.enableOrderBook !== false).map(m => presentMarket(m, opts));
  return {
    id: String(e.id), slug: e.slug, title: e.title, image: e.icon || e.image || null,
    volume_usd: num(e.volume), volume_24h_usd: num(e.volume24hr), liquidity_usd: num(e.liquidity), open_interest_usd: num(e.openInterest),
    end_date: e.endDate || null, neg_risk: !!e.negRisk, neg_risk_augmented: !!e.negRiskAugmented, restricted: !!e.restricted,
    tags: (e.tags || []).map(t => t.label).filter(Boolean).slice(0, 6),
    markets,
    ...(opts.full ? { description: e.description || null } : {}),
    url: e.slug ? `https://polymarket.com/event/${e.slug}` : null,
  };
}

const stamp = out => ({ ...out, source: pm.SOURCES.gamma, read_at: new Date().toISOString() });

/** Open events by 24-hour volume, or a search. */
async function browse({ q = '', limit = 20, offset = 0, tag = null } = {}) {
  limit = Math.min(50, Math.max(1, Number(limit) || 20)); offset = Math.max(0, Number(offset) || 0);
  const query = String(q || '').trim().slice(0, 100);
  const rows = query ? await pm.search(query, { limit }) : await pm.events({ limit, offset, tag: tag ? String(tag).slice(0, 60) : null });
  return stamp({ events: (rows || []).filter(e => !e.closed).map(e => presentEvent(e)), query: query || null, limit, offset: query ? 0 : offset });
}

async function eventBySlug(slug) {
  const e = await pm.event(slug);
  return e ? stamp({ event: presentEvent(e, { full: true }) }) : null;
}

/** One market with its resolution state read from the Data API; if that read fails the note says so. */
async function marketBySlug(slug) {
  const m = await pm.market(slug);
  if (!m) return null;
  let state; let stateError = null;
  try { state = m.conditionId ? await pm.resolution(m.conditionId) : null; } catch (err) { state = undefined; stateError = err.message; }
  const out = presentMarket(m, { state: state || undefined, full: true });
  if (stateError) out.resolution.not_checked = `Dispute history: ${stateError}`;
  return stamp({ market: out });
}

/** The book as the page needs it: best prices first on both sides, with the constraints orders must meet. */
function presentBook(b) {
  const side = (rows, desc) => (rows || []).map(r => ({ price: Number(r.price), size: Number(r.size) })).filter(r => r.size > 0).sort((a, c) => (desc ? c.price - a.price : a.price - c.price));
  const bids = side(b.bids, true); const asks = side(b.asks, false);
  return {
    asset_id: String(b.asset_id), condition_id: b.market || null, position_system: b.version === 'v2' ? 'v2' : 'ctf', neg_risk: !!b.neg_risk,
    tick_size: String(b.tick_size), min_order_size: String(b.min_order_size),
    best_bid: bids[0]?.price ?? null, best_ask: asks[0]?.price ?? null, last_trade_price: num(b.last_trade_price),
    bids: bids.slice(0, 15), asks: asks.slice(0, 15),
    source: pm.SOURCES.clob, read_at: new Date().toISOString(),
  };
}

/** A wallet's positions and Polymarket's PnL for each. */
async function positionsFor(wallet) {
  const { positions, complete } = await pm.positions(wallet);
  const rows = positions.filter(p => !p.archived).map(p => ({
    asset_id: String(p.token_id), condition_id: p.condition_id, title: p.title, slug: p.slug, event_slug: p.event_slug, outcome: p.outcome, outcome_index: p.outcome_index,
    size: num(p.current_size), avg_price: num(p.avg_price), current_price: num(p.current_price), value_usd: num(p.current_value), cost_usd: num(p.total_cost_usdc),
    pnl_usd: num(p.total_pnl), unrealized_pnl_usd: num(p.unrealized_pnl), realized_pnl_usd: num(p.realized_pnl), pnl_pct: num(p.percent_pnl),
    status: p.status || null, redeemable: !!p.redeemable, neg_risk: !!p.negative_risk, end_date: p.end_date || null,
  }));
  const sum = k => Math.round(rows.reduce((s, r) => s + (r[k] || 0), 0) * 100) / 100;
  return {
    wallet: String(wallet).toLowerCase(), positions: rows,
    totals: { value_usd: sum('value_usd'), pnl_usd: sum('pnl_usd'), redeemable: rows.filter(r => r.redeemable).length },
    complete, ...(complete ? {} : { note: 'More positions exist than were read: the totals cover only those shown.' }),
    source: pm.SOURCES.data, pnl_note: 'PnL is Polymarket\'s own figure from its Data API, not computed by RektBull.', read_at: new Date().toISOString(),
  };
}

module.exports = { browse, eventBySlug, marketBySlug, presentMarket, presentEvent, presentBook, positionsFor, resolutionNote, assetIds };

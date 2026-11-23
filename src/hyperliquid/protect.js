/**
 * Hyperliquid proposals, phase 1 (docs/HYPERLIQUID.md, "Protecting positions"),
 * decided by the owner on 23 November 2026: protect the positions a user already
 * holds, and say what's happening in the markets. Nothing here predicts a price
 * or proposes opening a position.
 *
 * Protection proposals, for one account's open positions, by stated rules (RULES):
 *   no_stop       no stop-loss that would close the position before its
 *                 liquidation price. Proposed: a stop-loss (reduce-only, the
 *                 whole position, at the market when it triggers), placed a few
 *                 typical hourly moves from the price and always before the
 *                 liquidation price.
 *   liq_near      the liquidation price is within a typical day's range (the
 *                 last 24 hours, high to low) or within 5%. Proposed: reduce
 *                 the position by half (reduce-only, immediate-or-cancel).
 *   funding_cost  the position is paying funding at 25% a year or more. Facts
 *                 only: what it costs a day and has cost since it opened.
 * Every proposal's order is reduce-only: it can close, never open or add.
 * Acting on one is the user's own signature, with the trading key in their
 * browser. Its order carries RektBull's proposal fee (HL_PROPOSAL_FEE_TENTHS_BPS,
 * 0.05% by default) instead of the 0.01% on the user's own orders, and the
 * relay accepts that fee only for an order that matches a live proposal.
 *
 * Market alerts, for the deep markets (open interest and 24-hour volume of at
 * least $5M each), from Hyperliquid's own data (MARKET_RULES):
 *   funding_extreme  funding of 100% a year or more, either way;
 *   mark_oracle      Hyperliquid's mark price 0.5% or more from the oracle price;
 *   oi_build         open interest up 10% or more in an hour while the price
 *                    moved less than 1%;
 *   oi_flush         open interest down 10% or more in an hour.
 *
 * No AI is used: each proposal's words are written from its facts, so nothing
 * can be filled in. Every fact names its source; what couldn't be read says why.
 */
const crypto = require('crypto');
const env = require('../config/env');
const db = require('../config/db');
const hl = require('../providers/hyperliquid');
const markets = require('./markets');
const H = require('../../public/hl-core.js');

const RULES = {
  stop_hourly_moves: 3, // a stop-loss 3 typical hourly moves from the price…
  stop_liq_share: 0.6, // …and never more than 60% of the way to the liquidation price
  stop_fallback_pct: 5, // when the candles can't be read and there's no liquidation price
  liq_min_pct: 5, // a liquidation price within 5%…
  // …or within a typical day's range (the last 24 hours, high to low), whichever is wider
  liq_critical_share: 0.5, // critical when it's within half of that
  funding_apr_pct: 25, // a position paying funding at 25% a year or more
  reduce_share: 0.5, // reduce by half
  slippage_pct: 1, // an immediate-or-cancel order at no worse than 1% from the mark
  stop_slippage_pct: 10, // the worst price a triggered stop-loss may take (as the Perps page sets it)
  expiry_minutes: 10, // a proposal is good for 10 minutes; then it's made again from fresh prices
};
const MARKET_RULES = { funding_apr_pct: 100, mark_oracle_pct: 0.5, oi_change_pct: 10, oi_flat_price_pct: 1, window_minutes: 60, keep_hours: 48 };
const CANDLES_SOURCE = 'Hyperliquid\'s hourly candles (info API)';
const HOURS_A_YEAR = 24 * 365;

const round = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const usd = v => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = v => Number(v).toLocaleString('en-US', { maximumSignificantDigits: 6 });

/** The proposal fee, or the main fee when it isn't set higher. { b, f } or null with no builder address. */
function proposalBuilder() {
  if (!env.hlBuilderAddress) return null;
  const f = Math.max(env.hlProposalFeeTenthsBps, env.hlBuilderFeeTenthsBps);
  return f > 0 ? { b: env.hlBuilderAddress, f } : null;
}

/**
 * A market's typical moves from its last 24 hourly candles: the average hourly
 * range (high to low, as a share of the close) and the whole day's range.
 */
async function moves(coin) {
  const end = Date.now();
  const rows = await hl.info({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: end - 25 * 3600000, endTime: end } }, { ttl: 300 });
  const c = (Array.isArray(rows) ? rows : []).slice(-24).map(x => ({ h: Number(x.h), l: Number(x.l), c: Number(x.c) })).filter(x => x.h > 0 && x.l > 0 && x.c > 0);
  if (c.length < 6) throw new Error(`only ${c.length} hourly candles came back`);
  const hourly = c.reduce((s, x) => s + (x.h - x.l) / x.c, 0) / c.length * 100;
  const day = (Math.max(...c.map(x => x.h)) - Math.min(...c.map(x => x.l))) / c[c.length - 1].c * 100;
  return { hourly_move_pct: round(hourly, 3), day_range_pct: round(day, 2), candles: c.length, source: CANDLES_SOURCE };
}

/** The stop-loss orders already on the book that would close this position before its liquidation price. */
function stopsFor(p, orders) {
  const closing = p.side === 'long' ? 'sell' : 'buy';
  return (orders || []).filter(o => o.coin === p.coin && o.trigger && o.reduce_only && o.side === closing && /stop/i.test(o.type || '')
    && (p.liquidation_px === null || (p.side === 'long' ? o.trigger_px > p.liquidation_px : o.trigger_px < p.liquidation_px)));
}

/** How far the liquidation price is from the mark, as a percentage (null when there's none). */
const liqDistance = (p, mark) => (p.liquidation_px === null || !(mark > 0) ? null : round((p.side === 'long' ? mark - p.liquidation_px : p.liquidation_px - mark) / mark * 100, 2));

/**
 * The proposals for one position. m: its market; mv: its typical moves, or { error }.
 * Returns plain objects; their orders are unsigned wires, every one reduce-only.
 */
function forPosition(p, m, mv, orders) {
  const out = [];
  const mark = m.mark_px;
  const isBuy = p.side === 'short'; // closing a short is a buy
  const dist = liqDistance(p, mark);
  const facts = [
    { text: `${p.side} ${fmt(p.size)} ${p.coin} at ${p.leverage ? `${p.leverage}x ${p.margin_mode || ''}`.trim() : 'its leverage'}, entered at ${fmt(p.entry_px)}; the mark price is ${fmt(mark)}`, source: 'Hyperliquid\'s info API (your account and its markets)' },
    p.liquidation_px === null
      ? { text: 'No liquidation price while your margin covers the position', source: 'Hyperliquid\'s info API' }
      : { text: `Liquidation price ${fmt(p.liquidation_px)}: ${dist}% from the mark`, source: 'Hyperliquid\'s info API' },
    mv.error ? { text: `A typical move couldn't be read: ${mv.error}`, source: CANDLES_SOURCE, not_checked: true }
      : { text: `A typical hour moves ${mv.hourly_move_pct}%; the last 24 hours ranged ${mv.day_range_pct}%`, source: mv.source },
  ];

  // liq_near: within a typical day's range, or within 5%.
  if (dist !== null) {
    const threshold = Math.max(RULES.liq_min_pct, mv.error ? 0 : mv.day_range_pct);
    if (dist < threshold) {
      const severity = dist < threshold * RULES.liq_critical_share ? 'critical' : 'high';
      const half = H.formatSize(p.size * RULES.reduce_share, m.sz_decimals);
      const order = Number(half) > 0 ? H.orderWire({ asset: m.asset, isBuy, px: H.slippagePrice(mark, isBuy, RULES.slippage_pct / 100, m.sz_decimals), sz: half, reduceOnly: true, tif: 'Ioc' }) : null;
      out.push({
        kind: 'liq_near', severity, coin: p.coin, asset: m.asset,
        title: `${p.coin} ${p.side}: liquidation is ${dist}% away`,
        why: `Your liquidation price is closer than ${mv.error ? `${RULES.liq_min_pct}%` : `a typical day's range (${threshold}%)`}. A liquidation takes the position's margin.`,
        facts,
        action: order ? {
          label: `Reduce by half: ${isBuy ? 'buy' : 'sell'} ${half} ${p.coin}`,
          does: `Closes half the position now, at no worse than ${H.slippagePrice(mark, isBuy, RULES.slippage_pct / 100, m.sz_decimals)} (${RULES.slippage_pct}% from the mark); what doesn't fill at once is cancelled. Reduce only: it can't open or add. Half the position is half what a liquidation could take; on cross margin it also moves the liquidation price away. Adding margin on Hyperliquid is the other way.`,
          orders: [order],
        } : null,
        ...(order ? {} : { no_action: `Half of ${p.size} ${p.coin} is below ${p.coin}'s smallest size.` }),
      });
    }
  }

  // no_stop: nothing on the book would close it before liquidation.
  if (!stopsFor(p, orders).length) {
    const fromMoves = mv.error ? null : RULES.stop_hourly_moves * mv.hourly_move_pct;
    let d = fromMoves ?? RULES.stop_fallback_pct;
    let rule = fromMoves !== null ? `${RULES.stop_hourly_moves} typical hourly moves (${round(fromMoves, 2)}%)` : `${RULES.stop_fallback_pct}%, as a typical move couldn't be read`;
    if (dist !== null && d > dist * RULES.stop_liq_share) {
      d = dist * RULES.stop_liq_share;
      rule = `${Math.round(RULES.stop_liq_share * 100)}% of the way to the liquidation price (${round(d, 2)}%), so it closes first`;
    }
    const stopPx = H.formatPrice(mark * (p.side === 'long' ? 1 - d / 100 : 1 + d / 100), m.sz_decimals, p.side === 'long' ? 'up' : 'down');
    const size = H.formatSize(p.size, m.sz_decimals);
    const lossFromMark = Math.abs(mark - Number(stopPx)) * p.size;
    const pnlAtStop = (p.side === 'long' ? Number(stopPx) - p.entry_px : p.entry_px - Number(stopPx)) * p.size;
    const order = H.orderWire({ asset: m.asset, isBuy, px: H.slippagePrice(Number(stopPx), isBuy, RULES.stop_slippage_pct / 100, m.sz_decimals), sz: size, reduceOnly: true, trigger: { triggerPx: stopPx, isMarket: true, tpsl: 'sl' } });
    out.push({
      kind: 'no_stop', severity: dist !== null && dist < RULES.liq_min_pct ? 'high' : 'medium', coin: p.coin, asset: m.asset,
      title: `${p.coin} ${p.side}: no stop-loss${p.liquidation_px === null ? '' : ' before liquidation'}`,
      why: p.liquidation_px === null ? 'Nothing on the book would close this position if the price turns.' : 'Nothing on the book would close this position before it\'s liquidated.',
      facts: [...facts, { text: `At ${stopPx} the position would be ${pnlAtStop >= 0 ? 'up' : 'down'} ${usd(pnlAtStop)} on its entry, ${usd(lossFromMark)} worse than now (before fees)`, source: 'Worked out from the facts above' }],
      action: {
        label: `Add a stop-loss at ${stopPx}`,
        does: `When ${p.coin} ${isBuy ? 'rises' : 'falls'} to ${stopPx}, close all ${size} ${p.coin} at the market. Placed ${rule}. Reduce only: it can't open or add. You can move or cancel it on this page.`,
        orders: [order],
      },
    });
  }

  // funding_cost: paying at 25% a year or more. Facts only.
  const f = m.funding_hourly_pct;
  const pays = f !== null && ((p.side === 'long' && f > 0) || (p.side === 'short' && f < 0));
  if (pays && Math.abs(f) * HOURS_A_YEAR >= RULES.funding_apr_pct && p.value_usd > 0) {
    const perDay = p.value_usd * Math.abs(f) / 100 * 24;
    out.push({
      kind: 'funding_cost', severity: 'medium', coin: p.coin, asset: m.asset,
      title: `${p.coin} ${p.side}: funding costs about ${usd(perDay)} a day`,
      why: `${p.side === 'long' ? 'Longs pay shorts' : 'Shorts pay longs'} ${round(Math.abs(f) * HOURS_A_YEAR, 1)}% a year at the current rate.`,
      facts: [
        { text: `Funding ${round(f, 4)}% an hour (${round(Math.abs(f) * HOURS_A_YEAR, 1)}% a year) on a ${usd(p.value_usd)} position: about ${usd(perDay)} a day${p.margin_used_usd ? `, ${round(perDay / p.margin_used_usd * 100, 2)}% of its margin` : ''}`, source: 'Hyperliquid\'s info API (the market\'s current funding rate)' },
        ...(p.funding_since_open_usd === null ? [] : [{ text: `Funding since it opened: ${p.funding_since_open_usd > 0 ? 'paid' : 'received'} ${usd(p.funding_since_open_usd)}`, source: 'Hyperliquid\'s info API (your position)' }]),
      ],
      action: null,
      no_action: 'Facts only: funding changes every hour. Closing or reducing is on this page.',
    });
  }
  // position: which position it's for (a new position at another price is a new one, for the alerts' once-only rule).
  return out.map(x => ({ ...x, mark_px: mark, position: `${p.side}:${p.entry_px}` }));
}

const RANK = { critical: 3, high: 2, medium: 1, low: 0 };

/**
 * The review of one account: its positions, the proposals for each, and what
 * couldn't be read. Reads only; save() stores the proposals that have an order.
 */
async function review(wallet, { ms = 4000 } = {}) {
  const [acct, list] = await Promise.all([markets.account(wallet, { ms }), markets.markets({ ms })]);
  const out = { wallet: acct.user, network: acct.network, checked_at: new Date().toISOString(), rules: RULES, proposals: [], not_checked: [], sources: [hl.SOURCE, CANDLES_SOURCE] };
  if (acct.positions_error) { out.not_checked.push(acct.positions_error); return out; }
  if (acct.open_orders_error) out.not_checked.push(`${acct.open_orders_error}: a stop-loss already on the book may be missed`);
  out.positions = acct.positions.length;
  for (const p of acct.positions) {
    const m = list.find(x => x.coin === p.coin);
    if (!m || !(m.mark_px > 0)) { out.not_checked.push(`${p.coin}: Hyperliquid shows no price for it`); continue; }
    let mv;
    try { mv = await moves(p.coin); } catch (err) { mv = { error: err.message }; out.not_checked.push(`${p.coin}: a typical move couldn't be read (${err.message}); the rules that need it used their fallback`); }
    // With the open orders unread, a stop may already exist: say so rather than propose a second one.
    const found = forPosition(p, m, mv, acct.open_orders || []).filter(x => !(x.kind === 'no_stop' && acct.open_orders_error));
    out.proposals.push(...found);
  }
  out.proposals.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  return out;
}

/** Stores the proposals that have an order, for the relay to check them against, and gives each its id and fee. */
async function save(account, r) {
  const b = proposalBuilder();
  const expires = new Date(Date.now() + RULES.expiry_minutes * 60000);
  for (const p of r.proposals.filter(x => x.action)) {
    p.id = crypto.randomUUID();
    p.expires_at = expires.toISOString();
    p.fee = b ? { tenths_bps: b.f, rate: H.feeRate(b.f), builder: b.b } : null;
    await db.query(
      `INSERT INTO hl_proposals (id, account_id, wallet, coin, asset, kind, severity, orders, fee_tenths_bps, mark_px, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [p.id, account.id, account.wallet, p.coin, p.asset, p.kind, p.severity, JSON.stringify(p.action.orders), b ? b.f : 0, p.mark_px ?? null, expires],
    );
  }
  return r;
}

/** A live proposal of this account's, for the relay; null when there's none (unknown, someone else's, used or expired). */
async function live(accountId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const { rows } = await db.query('SELECT id, asset, coin, kind, orders, fee_tenths_bps FROM hl_proposals WHERE id = $1 AND account_id = $2 AND expires_at > now() AND acted_at IS NULL', [id, accountId]);
  return rows[0] || null;
}
const acted = id => db.query('UPDATE hl_proposals SET acted_at = now() WHERE id = $1', [id]);

/* ── market alerts ── */

/** The job, every 5 minutes: a snapshot of the deep markets, for the open-interest alerts; old ones are dropped. */
async function snapshot() {
  const list = (await markets.markets({ ms: 0 })).filter(m => m.auto && m.mark_px > 0 && m.open_interest_usd > 0);
  for (const m of list) {
    await db.query('INSERT INTO hl_market_snapshots (coin, at, mark_px, open_interest_usd, funding_hourly_pct) VALUES ($1, now(), $2, $3, $4) ON CONFLICT DO NOTHING', [m.coin, m.mark_px, m.open_interest_usd, m.funding_hourly_pct]);
  }
  await db.query(`DELETE FROM hl_market_snapshots WHERE at < now() - make_interval(hours => $1)`, [MARKET_RULES.keep_hours]);
  await db.query(`DELETE FROM hl_proposals WHERE acted_at IS NULL AND expires_at < now() - interval '1 day'`);
  return list.length;
}

/** The market alerts now, for the deep markets. */
async function marketAlerts({ ms = 3000 } = {}) {
  const list = (await markets.markets({ ms })).filter(m => m.auto && m.mark_px > 0);
  const { rows } = await db.query(
    `SELECT DISTINCT ON (coin) coin, at, mark_px::float8 AS mark_px, open_interest_usd::float8 AS oi FROM hl_market_snapshots
      WHERE at <= now() - make_interval(mins => $1) AND at > now() - make_interval(mins => $2) ORDER BY coin, at DESC`,
    [MARKET_RULES.window_minutes, MARKET_RULES.window_minutes + 30],
  );
  const before = Object.fromEntries(rows.map(r => [r.coin, r]));
  const alerts = [];
  const src = 'Hyperliquid\'s info API';
  for (const m of list) {
    const apr = m.funding_hourly_pct === null ? null : m.funding_hourly_pct * HOURS_A_YEAR;
    if (apr !== null && Math.abs(apr) >= MARKET_RULES.funding_apr_pct) {
      alerts.push({ kind: 'funding_extreme', coin: m.coin, severity: Math.abs(apr) >= 2 * MARKET_RULES.funding_apr_pct ? 'high' : 'medium',
        title: `${m.coin}: ${apr > 0 ? 'longs pay shorts' : 'shorts pay longs'} ${round(Math.abs(apr), 0)}% a year`,
        text: `Funding is ${round(m.funding_hourly_pct, 4)}% an hour. The ${apr > 0 ? 'long' : 'short'} side is crowded and paying heavily to stay in.`, source: src });
    }
    if (m.oracle_px > 0) {
      const gap = (m.mark_px - m.oracle_px) / m.oracle_px * 100;
      if (Math.abs(gap) >= MARKET_RULES.mark_oracle_pct) {
        alerts.push({ kind: 'mark_oracle', coin: m.coin, severity: 'medium', title: `${m.coin}: Hyperliquid's price is ${round(Math.abs(gap), 2)}% ${gap > 0 ? 'above' : 'below'} the oracle`,
          text: `Mark ${fmt(m.mark_px)}, oracle ${fmt(m.oracle_px)} (the oracle is the price on major exchanges). Gaps like this tend to close; automatic trading refuses orders while they're wide.`, source: src });
      }
    }
    const b = before[m.coin];
    if (b && b.oi > 0 && m.open_interest_usd > 0) {
      const oi = (m.open_interest_usd - b.oi) / b.oi * 100;
      const move = (m.mark_px - b.mark_px) / b.mark_px * 100;
      const mins = Math.round((Date.now() - new Date(b.at)) / 60000);
      if (oi >= MARKET_RULES.oi_change_pct && Math.abs(move) < MARKET_RULES.oi_flat_price_pct) {
        alerts.push({ kind: 'oi_build', coin: m.coin, severity: 'medium', title: `${m.coin}: open interest up ${round(oi, 1)}% in ${mins} minutes, price flat`,
          text: `Positions are building (${usd(b.oi)} to ${usd(m.open_interest_usd)}) while the price moved ${round(move, 2)}%. A sharp move often follows, in either direction.`, source: `${src}, RektBull's snapshots every 5 minutes` });
      } else if (oi <= -MARKET_RULES.oi_change_pct) {
        alerts.push({ kind: 'oi_flush', coin: m.coin, severity: 'medium', title: `${m.coin}: open interest down ${round(Math.abs(oi), 1)}% in ${mins} minutes`,
          text: `Positions were closed in a hurry (${usd(b.oi)} to ${usd(m.open_interest_usd)}), with the price ${move >= 0 ? 'up' : 'down'} ${round(Math.abs(move), 2)}%: often liquidations.`, source: `${src}, RektBull's snapshots every 5 minutes` });
      }
    }
  }
  alerts.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  return { as_of: new Date().toISOString(), network: hl.network(), rules: MARKET_RULES, markets: list.length, oi_history: rows.length > 0, alerts };
}

module.exports = { RULES, MARKET_RULES, proposalBuilder, moves, stopsFor, liqDistance, forPosition, review, save, live, acted, snapshot, marketAlerts };

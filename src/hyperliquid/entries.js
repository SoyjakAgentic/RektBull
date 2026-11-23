/**
 * Hyperliquid entry proposals, phase 2 (docs/HYPERLIQUID.md, "Entry
 * proposals"). Phase 1 protects positions users hold (protect.js); this one
 * proposes opening one, so it is held to a stricter test first: stated rules,
 * run and scored in public in shadow before anyone is offered them. The owner
 * asked for it on 23 November 2026.
 *
 * The rules, on the 20 busiest deep markets (open interest and 24-hour volume
 * of $5M or more each), once an hour after the hourly candle closes:
 *   breakout        the hour closed beyond the previous 24 hours' range, on at
 *                   least 1.5 times their average volume: the way it broke;
 *   funding_fade    funding of 100% a year or more one way, and the last 4
 *                   hours moved against that crowd: the other way;
 *   flush_reversal  open interest down 10% or more in the last hour, on a
 *                   price move of 3% or more: against the move.
 * Each signal is a full bracket: entry at the mark price, a stop-loss 2
 * typical hourly moves away (at least 0.5%, at most 5%), and a take-profit at
 * twice the stop's distance (2R). It's good to act on for 15 minutes, while the
 * price stays within 0.5% of its entry.
 *
 * Scoring, in R (multiples of the stop's distance), net of costs: Hyperliquid's
 * taker fee and RektBull's proposal fee, both ways, and funding at the rate
 * when it was entered (an estimate: funding changes every hour). Each signal is
 * marked at 1, 4 and 24 hours, and finally at its take-profit, its stop (when a
 * 15-minute candle reaches both, the stop counts), or its 24-hour close, from
 * the first 15-minute candle that opens after the entry.
 *
 * In shadow (the forecasts setting `hyperliquid`) the signals are logged and
 * scored, and the scorecard is public; nobody is offered them. With
 * `hyperliquid_proposals` on too, users who asked for Hyperliquid proposals see
 * them on the Perps page, each sized for their account (1% of it at risk),
 * isolated margin, signed by the trading key in their browser, with the
 * proposal fee (HL_PROPOSAL_FEE_TENTHS_BPS). The relay accepts that fee only
 * on the exact orders proposed. No AI is used: the words come from the facts.
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const hl = require('../providers/hyperliquid');
const markets = require('./markets');
const protect = require('./protect');
const H = require('../../public/hl-core.js');

const RULES = {
  markets: 20, // the busiest deep markets by 24-hour volume
  breakout_hours: 24,
  breakout_volume_x: 1.5,
  funding_apr_pct: 100,
  funding_turn_hours: 4,
  flush_oi_pct: 10,
  flush_move_pct: 3,
  stop_hourly_moves: 2,
  stop_min_pct: 0.5,
  stop_max_pct: 5,
  tp_r: 2,
  act_minutes: 15, // a signal can be acted on this long after it's made...
  act_band_pct: 0.5, // ...while the price is within this of its entry
  horizon_hours: 24,
  risk_pct: 1, // a user's proposal risks this share of their account value at the stop
  max_leverage: 10,
};
// Hyperliquid's base-tier perps taker fee (its fee schedule; volume tiers pay less): the cost assumed for scoring.
const HL_TAKER_PCT = 0.045;
const CANDLES = 'Hyperliquid\'s candles (info API)';
const HOURS_A_YEAR = 24 * 365;
const r2 = v => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

const settings = () => require('../forecasts/settings').get();
const proposalFeePct = () => (protect.proposalBuilder()?.f || 0) / 1000;

/** Closed candles only: Hyperliquid returns the one still forming last. */
async function candles(coin, interval, hours, now = Date.now()) {
  const rows = await hl.info({ type: 'candleSnapshot', req: { coin, interval, startTime: now - hours * 3600000, endTime: now } }, { ttl: interval === '1h' ? 300 : 120 });
  return (Array.isArray(rows) ? rows : []).map(c => ({ t: Number(c.t), T: Number(c.T), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) }))
    .filter(c => c.T <= now && c.h > 0 && c.l > 0);
}

/** The bracket for a side at an entry price, from the market's typical hourly move. */
function bracket(side, entry, hourlyMovePct) {
  const stopPct = Math.min(RULES.stop_max_pct, Math.max(RULES.stop_min_pct, RULES.stop_hourly_moves * hourlyMovePct));
  const d = entry * stopPct / 100;
  const long = side === 'long';
  return { stop_pct: r2(stopPct * 100) / 100, stop_px: long ? entry - d : entry + d, tp_px: long ? entry + RULES.tp_r * d : entry - RULES.tp_r * d };
}

/**
 * The rules for one market. m: its market row (markets.js); hours: its last
 * 25 closed hourly candles, oldest first; before: its open interest and mark
 * from RektBull's snapshot about an hour ago, or null. Returns signals.
 */
function check(m, hours, before) {
  const out = [];
  if (hours.length < RULES.breakout_hours + 1) return out;
  const last = hours[hours.length - 1];
  const prior = hours.slice(-RULES.breakout_hours - 1, -1);
  const hourly = prior.reduce((s, c) => s + (c.h - c.l) / c.c, 0) / prior.length * 100;
  const avgVol = prior.reduce((s, c) => s + c.v, 0) / prior.length;
  const hi = Math.max(...prior.map(c => c.h));
  const lo = Math.min(...prior.map(c => c.l));
  const base = { coin: m.coin, asset: m.asset, entry_px: m.mark_px, funding_hourly_pct: m.funding_hourly_pct, hourly_move_pct: r2(hourly) };
  const fact = (text, source = CANDLES) => ({ text, source });

  // Breakout: closed beyond the range, on volume.
  if (avgVol > 0 && last.v >= RULES.breakout_volume_x * avgVol && (last.c > hi || last.c < lo)) {
    const side = last.c > hi ? 'long' : 'short';
    out.push({ ...base, rule: 'breakout', side, facts: [
      fact(`The last hour closed at ${last.c}, ${side === 'long' ? 'above the previous 24 hours\' high of ' + hi : 'below the previous 24 hours\' low of ' + lo}`),
      fact(`On ${r2(last.v / avgVol)} times the 24-hour average volume`),
    ] });
  }

  // Funding fade: a crowd paying heavily, and the price turning against it.
  const apr = m.funding_hourly_pct === null ? null : m.funding_hourly_pct * HOURS_A_YEAR;
  const turn = hours[hours.length - 1 - RULES.funding_turn_hours];
  if (apr !== null && Math.abs(apr) >= RULES.funding_apr_pct && turn) {
    const move = (last.c - turn.c) / turn.c * 100;
    const longsPay = apr > 0;
    if ((longsPay && move < 0) || (!longsPay && move > 0)) {
      out.push({ ...base, rule: 'funding_fade', side: longsPay ? 'short' : 'long', facts: [
        fact(`${longsPay ? 'Longs pay shorts' : 'Shorts pay longs'} ${r2(Math.abs(apr))}% a year (${r2(m.funding_hourly_pct * 10000) / 10000}% an hour)`, 'Hyperliquid\'s info API (the market\'s funding rate)'),
        fact(`The price moved ${r2(move)}% over the last ${RULES.funding_turn_hours} hours, against that crowd`),
      ] });
    }
  }

  // Flush reversal: positions closed in a hurry on a big move.
  if (before && before.oi > 0 && m.open_interest_usd > 0 && before.mark_px > 0) {
    const oi = (m.open_interest_usd - before.oi) / before.oi * 100;
    const move = (m.mark_px - before.mark_px) / before.mark_px * 100;
    if (oi <= -RULES.flush_oi_pct && Math.abs(move) >= RULES.flush_move_pct) {
      out.push({ ...base, rule: 'flush_reversal', side: move < 0 ? 'long' : 'short', facts: [
        fact(`Open interest down ${r2(Math.abs(oi))}% in about an hour`, 'Hyperliquid\'s info API, against RektBull\'s snapshot an hour before'),
        fact(`While the price moved ${r2(move)}%: often liquidations, which tend to overshoot`, 'Hyperliquid\'s info API, against RektBull\'s snapshot an hour before'),
      ] });
    }
  }
  return out.map(s => ({ ...s, ...bracket(s.side, s.entry_px, hourly), facts: [...s.facts, fact(`A typical hour moves ${r2(hourly)}% (high to low, the last 24 hours)`)] }));
}

/**
 * The job, every 5 minutes: runs the rules once per hourly candle (the first
 * run after it closes), then scores the open signals. Off unless the forecasts
 * setting `hyperliquid` is on.
 */
async function tick(now = Date.now()) {
  if (!settings().hyperliquid) return { off: true };
  const found = await run(now).catch(err => { logger.warn('hyperliquid rules failed', { error: err.message }); return null; });
  const scored = await score(now).catch(err => { logger.warn('hyperliquid scoring failed', { error: err.message }); return 0; });
  return { found, scored };
}

async function run(now = Date.now()) {
  const hour = new Date(Math.floor(now / 3600000) * 3600000);
  const { rows: done } = await db.query('SELECT 1 FROM hl_signal_runs WHERE hour = $1', [hour]);
  if (done.length) return null;
  const all = (await markets.markets({ ms: 0 })).filter(m => m.auto && m.mark_px > 0);
  const busiest = all.sort((a, b) => (b.day_volume_usd || 0) - (a.day_volume_usd || 0)).slice(0, RULES.markets);
  const { rows: snaps } = await db.query(
    `SELECT DISTINCT ON (coin) coin, mark_px::float8 AS mark_px, open_interest_usd::float8 AS oi FROM hl_market_snapshots
      WHERE at <= now() - interval '55 minutes' AND at > now() - interval '90 minutes' ORDER BY coin, at DESC`,
  );
  const before = Object.fromEntries(snaps.map(s => [s.coin, s]));
  const notChecked = [];
  let found = 0;
  const offered = !!settings().hyperliquid_proposals;
  for (const m of busiest) {
    let hours;
    try { hours = await candles(m.coin, '1h', RULES.breakout_hours + 2, now); } catch (err) { notChecked.push(`${m.coin}: ${err.message}`); continue; }
    for (const s of check(m, hours, before[m.coin] || null)) {
      const { rowCount } = await db.query(
        `INSERT INTO hl_signals (coin, asset, rule, side, entry_px, stop_px, tp_px, stop_pct, funding_hourly_pct, facts, offered)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (coin, rule) WHERE status = 'open' DO NOTHING`,
        [s.coin, s.asset, s.rule, s.side, s.entry_px, s.stop_px, s.tp_px, s.stop_pct, s.funding_hourly_pct, JSON.stringify(s.facts), offered],
      );
      found += rowCount;
    }
  }
  await db.query('INSERT INTO hl_signal_runs (hour, markets, found, not_checked) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [hour, busiest.length, found, JSON.stringify(notChecked)]);
  if (found) logger.info('hyperliquid entry signals', { found, offered });
  return found;
}

/** Costs in R: both ways' fees, and funding at the entry rate for the hours held (paid when it's against the side). */
function costsR(s, hoursHeld) {
  const stop = Number(s.stop_pct);
  const fees = 2 * (HL_TAKER_PCT + proposalFeePct());
  const f = s.funding_hourly_pct === null ? 0 : Number(s.funding_hourly_pct);
  const funding = (s.side === 'long' ? f : -f) * hoursHeld; // positive: paid
  return (fees + funding) / stop;
}
const rAt = (s, px) => (s.side === 'long' ? px - Number(s.entry_px) : Number(s.entry_px) - px) / (Number(s.entry_px) * Number(s.stop_pct) / 100);

/**
 * Walks a signal's 15-minute candles from its entry: the stop or the
 * take-profit, whichever comes first (the stop when one candle reaches both),
 * else the close at 24 hours. Returns what to store, or null while it's open
 * with nothing to record yet.
 */
function walk(s, bars, now = Date.now()) {
  const t0 = new Date(s.created_at).getTime();
  const long = s.side === 'long';
  const stop = Number(s.stop_px); const tp = Number(s.tp_px);
  const out = {};
  const mark = (key, hours, px) => { if (out[key] === undefined && px !== null) out[key] = r2(rAt(s, px) - costsR(s, hours)); };
  // From the first candle that opens after the entry: earlier prices must never count as reaching the stop or take-profit.
  for (const b of bars.filter(x => x.t >= t0)) {
    const hit = long ? (b.l <= stop ? 'stop' : b.h >= tp ? 'tp' : null) : (b.h >= stop ? 'stop' : b.l <= tp ? 'tp' : null);
    const hoursIn = (b.T + 1 - t0) / 3600000; // a candle ends 1 ms before the next starts
    if (hit) {
      const px = hit === 'stop' ? stop : tp;
      const final = r2(rAt(s, px) - costsR(s, hoursIn));
      for (const k of ['r_1h', 'r_4h', 'r_24h']) if (out[k] === undefined) out[k] = final;
      return { ...out, status: hit, exit_px: px, r_final: final, costs_r: r2(costsR(s, hoursIn)), resolved_at: new Date(b.T) };
    }
    if (hoursIn >= 1) mark('r_1h', 1, b.c);
    if (hoursIn >= 4) mark('r_4h', 4, b.c);
    if (hoursIn >= RULES.horizon_hours) {
      mark('r_24h', RULES.horizon_hours, b.c);
      return { ...out, status: 'expired', exit_px: b.c, r_final: out.r_24h, costs_r: r2(costsR(s, RULES.horizon_hours)), resolved_at: new Date(b.T) };
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Scores the open signals (each at most every 15 minutes). One candle read per signal. */
async function score(now = Date.now()) {
  const { rows } = await db.query(`SELECT * FROM hl_signals WHERE status = 'open' AND (checked_at IS NULL OR checked_at < now() - interval '14 minutes') ORDER BY created_at LIMIT 40`);
  let n = 0;
  for (const s of rows) {
    let bars;
    try { bars = await candles(s.coin, '15m', (now - new Date(s.created_at).getTime()) / 3600000 + 0.5, now); } catch (err) {
      // Past its horizon by a day with nothing readable: given up on, and counted as unscored, not guessed.
      if (now - new Date(s.created_at).getTime() > (RULES.horizon_hours + 24) * 3600000) await db.query(`UPDATE hl_signals SET status = 'unscored', resolved_at = now() WHERE id = $1`, [s.id]);
      continue;
    }
    const got = walk(s, bars, now) || {};
    // The status is set once resolved; each R, once recorded, is kept (COALESCE keeps the first value).
    const keys = ['r_1h', 'r_4h', 'r_24h', 'r_final', 'costs_r', 'status', 'exit_px', 'resolved_at'].filter(k => got[k] !== undefined);
    const set = keys.map((k, i) => (k === 'status' ? `status = $${i + 2}` : `${k} = COALESCE(${k}, $${i + 2})`));
    await db.query(`UPDATE hl_signals SET ${['checked_at = now()', ...set].join(', ')} WHERE id = $1`, [s.id, ...keys.map(k => got[k])]);
    if (got.status) n++;
  }
  return n;
}

/** The public scorecard: by rule and overall, shadow and offered alike, and the latest signals. */
async function trackRecord() {
  const { rows: by } = await db.query(`SELECT rule, count(*)::int AS signals,
      count(*) FILTER (WHERE status IN ('tp', 'stop', 'expired'))::int AS scored,
      count(*) FILTER (WHERE status = 'tp')::int AS take_profit, count(*) FILTER (WHERE status = 'stop')::int AS stopped,
      count(*) FILTER (WHERE status = 'expired')::int AS expired,
      round(avg(r_final) FILTER (WHERE r_final IS NOT NULL), 2)::float8 AS avg_r, round(sum(r_final) FILTER (WHERE r_final IS NOT NULL), 2)::float8 AS total_r,
      round(avg(r_1h) FILTER (WHERE r_1h IS NOT NULL), 2)::float8 AS avg_r_1h, round(avg(r_4h) FILTER (WHERE r_4h IS NOT NULL), 2)::float8 AS avg_r_4h
    FROM hl_signals GROUP BY rule ORDER BY rule`);
  const { rows: latest } = await db.query(`SELECT id, coin, rule, side, entry_px::float8, stop_px::float8, tp_px::float8, stop_pct::float8, facts, offered, created_at, status, r_1h::float8, r_4h::float8, r_final::float8, costs_r::float8, resolved_at
    FROM hl_signals ORDER BY created_at DESC LIMIT 20`);
  const all = by.reduce((a, r) => ({ signals: a.signals + r.signals, scored: a.scored + r.scored, take_profit: a.take_profit + r.take_profit, total_r: r2((a.total_r || 0) + (r.total_r || 0)) }), { signals: 0, scored: 0, take_profit: 0, total_r: 0 });
  const s = settings();
  return {
    mode: !s.hyperliquid ? 'off' : s.hyperliquid_proposals ? 'offered' : 'shadow',
    rules: RULES, costs: { hyperliquid_taker_pct: HL_TAKER_PCT, proposal_fee_pct: proposalFeePct(), funding: 'at the rate when entered, times the hours held (an estimate)' },
    overall: { ...all, avg_r: all.scored ? r2(all.total_r / all.scored) : null, win_rate_pct: all.scored ? r2(all.take_profit / all.scored * 100) : null },
    by_rule: by, latest,
    about: 'Entry signals from stated rules, each a bracket (entry, stop-loss at 1R, take-profit at 2R), scored in R net of fees and estimated funding. A positive average R over many signals is the only thing that would justify offering them. Past results don\'t predict future ones; nothing here is financial advice.',
    source: `${CANDLES}, scored every 15 minutes`,
  };
}

/** The signals a user may act on now: made within act_minutes, still open, while proposals are offered. */
async function actionable(now = Date.now()) {
  const { rows } = await db.query(`SELECT id, coin, asset, rule, side, entry_px::float8, stop_px::float8, tp_px::float8, stop_pct::float8, facts, created_at FROM hl_signals
    WHERE status = 'open' AND offered AND created_at > $1 ORDER BY created_at DESC`, [new Date(now - RULES.act_minutes * 60000)]);
  return rows;
}

class EntryRefused extends Error {
  constructor(message, status = 409, code = 'entry_refused') { super(message); this.status = status; this.code = code; }
}

/**
 * The bracket for one account, sized to it: 1% of its account value at the
 * stop, isolated margin at a leverage that keeps liquidation well past the
 * stop, no more margin than it has free. Saved as a proposal (protect.js's
 * table, kind 'entry') so the relay accepts the proposal fee on exactly these
 * orders, for 2 minutes.
 */
async function bracketFor(account, signalId, now = Date.now()) {
  const s = settings();
  if (!s.hyperliquid || !s.hyperliquid_proposals) throw new EntryRefused('Hyperliquid entry proposals aren\'t offered yet: they\'re being scored in public first.', 403, 'not_offered');
  const opted = await require('../forecasts/proposals').getSettings(account.id);
  if (!opted.hyperliquid) throw new EntryRefused('Ask for Hyperliquid proposals first (the switch on this card).', 403, 'not_opted_in');
  const sig = (await actionable(now)).find(x => String(x.id) === String(signalId));
  if (!sig) throw new EntryRefused('This signal is no longer open to act on: signals are good for 15 minutes.', 409, 'signal_expired');
  const [m, acct] = await Promise.all([markets.market(sig.coin, { ms: 0 }), markets.account(account.wallet, { ms: 0 })]);
  if (acct.positions_error) throw new EntryRefused(acct.positions_error, 503, 'account_unreadable');
  const mark = m.mark_px;
  const drift = Math.abs(mark - sig.entry_px) / sig.entry_px * 100;
  if (drift > RULES.act_band_pct) throw new EntryRefused(`The price has moved ${r2(drift)}% from the signal's entry (${sig.entry_px}), past the ${RULES.act_band_pct}% it allows.`, 409, 'price_moved');
  if (acct.positions.some(p => p.coin === sig.coin)) throw new EntryRefused(`You already hold a ${sig.coin} position: an entry proposal opens one only where you have none.`, 409, 'already_open');
  const stopPct = sig.stop_pct;
  const lev = Math.max(1, Math.min(RULES.max_leverage, m.max_leverage, Math.floor(100 / (2 * stopPct))));
  const riskUsd = (acct.account_value_usd || 0) * RULES.risk_pct / 100;
  let notional = riskUsd / (stopPct / 100);
  const maxByMargin = (acct.withdrawable_usd || 0) * lev * 0.95;
  const capped = notional > maxByMargin;
  notional = Math.min(notional, maxByMargin);
  const size = H.formatSize(notional / mark, m.sz_decimals);
  if (!(Number(size) * mark >= 10)) throw new EntryRefused(`At ${RULES.risk_pct}% of your account at risk, this would be under Hyperliquid's $10 smallest order. Add margin on Hyperliquid, or skip this one.`, 409, 'too_small');
  const isBuy = sig.side === 'long';
  const b = protect.proposalBuilder();
  const orders = [
    H.orderWire({ asset: m.asset, isBuy, px: H.slippagePrice(mark, isBuy, RULES.act_band_pct / 100, m.sz_decimals), sz: size, reduceOnly: false, tif: 'Ioc' }),
    H.orderWire({ asset: m.asset, isBuy: !isBuy, px: H.slippagePrice(sig.stop_px, !isBuy, 0.1, m.sz_decimals), sz: size, reduceOnly: true, trigger: { triggerPx: H.formatPrice(sig.stop_px, m.sz_decimals), isMarket: true, tpsl: 'sl' } }),
    H.orderWire({ asset: m.asset, isBuy: !isBuy, px: H.slippagePrice(sig.tp_px, !isBuy, 0.1, m.sz_decimals), sz: size, reduceOnly: true, trigger: { triggerPx: H.formatPrice(sig.tp_px, m.sz_decimals), isMarket: true, tpsl: 'tp' } }),
  ];
  const id = require('crypto').randomUUID();
  await db.query(
    `INSERT INTO hl_proposals (id, account_id, wallet, coin, asset, kind, severity, orders, fee_tenths_bps, mark_px, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'entry', 'entry', $6, $7, $8, $9)`,
    [id, account.id, account.wallet, m.coin, m.asset, JSON.stringify(orders), b ? b.f : 0, mark, new Date(now + 2 * 60000)],
  );
  const loss = Number(size) * mark * stopPct / 100;
  return {
    id, signal_id: sig.id, coin: m.coin, side: sig.side, rule: sig.rule, size, leverage: lev, margin_mode: 'isolated', mark_px: mark,
    entry_limit_px: orders[0].p, stop_px: orders[1].t.trigger.triggerPx, tp_px: orders[2].t.trigger.triggerPx,
    notional_usd: r2(Number(size) * mark), risk_usd: r2(loss), margin_usd: r2(Number(size) * mark / lev),
    ...(capped ? { note: 'Sized down to the margin you have free.' } : {}),
    action: { orders, grouping: 'normalTpsl' }, leverage_action: H.updateLeverageAction({ asset: m.asset, isCross: false, leverage: lev }),
    fee: b ? { tenths_bps: b.f, rate: H.feeRate(b.f), builder: b.b } : null,
    expires_at: new Date(now + 2 * 60000).toISOString(),
    says: `Opens a ${sig.side} of ${size} ${m.coin} now (at no worse than ${orders[0].p}), ${lev}x isolated, with a stop-loss at ${orders[1].t.trigger.triggerPx} and a take-profit at ${orders[2].t.trigger.triggerPx}. At the stop you'd lose about $${r2(loss)} (${RULES.risk_pct}% of your account) plus fees; the most you can lose is the margin in this position. Not financial advice.`,
  };
}

module.exports = { RULES, HL_TAKER_PCT, check, bracket, walk, costsR, tick, run, score, trackRecord, actionable, bracketFor, EntryRefused, candles };

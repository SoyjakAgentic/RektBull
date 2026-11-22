/**
 * RektBull Points (docs/POINTS.md).
 *
 * Earned: a rebate of the trading fees RektBull earns from a user, 25% of the
 * fee by default, at $0.10 a point. Every trading fee counts: the swap fees
 * (EVM and Solana, signed or automatic), the Hyperliquid builder fee, the
 * Polymarket builder fee and the Polymarket profit share. A point is credited
 * only once the fee is known to have been earned (a confirmed trade, a fill
 * Hyperliquid or Polymarket reports, a confirmed redemption), and once per fee.
 *
 * At most 1,000,000,000 points are ever issued (CAP). When they run out,
 * rebates stop; points already earned stay.
 *
 * Spent: on subscriptions (prepaid passes), at the point's value.
 *
 * These are not the monthly free points for safety checks
 * (payments/points.js): that's a separate allowance.
 *
 * The value, the rebate and the wording about a future token are admin
 * settings (`rewards`), changed with a reason and logged.
 */
const crypto = require('crypto');
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const settings = require('../admin/settings');
const { product, PRODUCTS } = require('../payments/catalog');

const CAP = 1_000_000_000;
const LOCK_ID = 727010; // one issuer at a time, so the cap is never passed
const DEFAULTS = {
  point_usd: 0.10,
  rebate_bps: 2500,
  token_note: 'RektBull Points will be convertible 1:1 for a RektBull utility token at its token generation event (TGE).',
};
const SOURCES = {
  swap: 'Swap fee (trade you signed)',
  auto_swap: 'Swap fee (automatic trade)',
  perps: 'Hyperliquid perps fee',
  perps_auto: 'Hyperliquid perps fee (automatic)',
  polymarket_fill: 'Polymarket trading fee',
  polymarket_profit: 'Polymarket profit share',
  pass: 'Subscription bought with points',
  ai_topup: 'Safety Pro AI top-up bought with points',
};

function config() {
  const s = settings.get('rewards') || {};
  return {
    point_usd: Number(s.point_usd ?? DEFAULTS.point_usd),
    rebate_bps: Number(s.rebate_bps ?? DEFAULTS.rebate_bps),
    token_note: String(s.token_note ?? DEFAULTS.token_note),
    cap: CAP,
  };
}

const round4 = n => Math.floor(n * 10000) / 10000;
/** Points earned for a fee of feeUsd (rounded down to 0.0001). */
const pointsFor = (feeUsd, c = config()) => round4((Number(feeUsd) || 0) * c.rebate_bps / 10000 / c.point_usd);

/**
 * Credits the rebate for one fee. Idempotent per (source, ref). Returns the
 * row, or null when nothing is due (no fee, no account, the cap is reached,
 * or it was credited already).
 */
async function credit({ accountId, source, ref, feeUsd, note = null }) {
  if (!env.databaseUrl || !accountId || !SOURCES[source] || !ref) return null;
  const want = pointsFor(feeUsd);
  if (!(want > 0)) return null;
  return db.tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    const { rows: [{ issued }] } = await c.query('SELECT COALESCE(SUM(points), 0) AS issued FROM reward_points WHERE points > 0');
    const grant = Math.min(want, round4(CAP - Number(issued)));
    if (!(grant > 0)) return null;
    const { rows } = await c.query(
      `INSERT INTO reward_points (account_id, points, kind, source, ref, fee_usd, note) VALUES ($1, $2, 'rebate', $3, $4, $5, $6)
       ON CONFLICT (source, ref) DO NOTHING RETURNING *`,
      [accountId, grant, source, String(ref), Number(feeUsd), note || (grant < want ? `The last ${grant} of the ${CAP.toLocaleString('en-US')} RektBull Points.` : null)],
    );
    return rows[0] || null;
  });
}

/** credit(), for the places a fee is earned: a rebate that can't be written never stops the trade it's for. */
function safeCredit(args) {
  return credit(args).catch(err => { logger.error('RektBull Points rebate failed', { source: args.source, ref: args.ref, error: err.message }); return null; });
}

async function balance(accountId, c = db) {
  const { rows: [r] } = await c.query('SELECT COALESCE(SUM(points), 0) AS b FROM reward_points WHERE account_id = $1', [accountId]);
  return Number(r.b);
}

async function supply() {
  const { rows: [r] } = await db.query('SELECT COALESCE(SUM(points) FILTER (WHERE points > 0), 0) AS issued FROM reward_points');
  const issued = Number(r.issued);
  return { cap: CAP, issued, remaining: Math.max(0, CAP - issued) };
}

/** The passes (subscriptions) and what each costs in points. */
function passPrices(c = config()) {
  return Object.entries(PRODUCTS).filter(([, p]) => p.kind === 'pass').map(([id]) => {
    const p = product(id);
    return { id, title: p.title, days: p.days, price_usd: p.price_cents / 100, points: Math.ceil(p.price_cents / 100 / c.point_usd) };
  });
}

class NotEnoughPoints extends Error {
  constructor(have, need) { super(`This costs ${need} RektBull Points; you have ${have}.`); this.status = 402; this.code = 'not_enough_points'; }
}

/** Spends points on something else RektBull sells (an AI top-up): throws NotEnoughPoints, or records the spend. */
async function spend(accountId, points, { source, ref, note = null }) {
  if (!SOURCES[source] || !(points > 0)) throw new Error('nothing to spend');
  return db.tx(async c => {
    await c.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    const have = await balance(accountId, c);
    if (have < points) throw new NotEnoughPoints(have, points);
    await c.query(`INSERT INTO reward_points (account_id, points, kind, source, ref, note) VALUES ($1, $2, 'spend', $3, $4, $5)`, [accountId, -points, source, String(ref), note]);
    return round4(have - points);
  });
}

/** Buys a pass (subscription) with points, in one transaction. */
async function buyPass(accountId, productId) {
  const p = product(productId);
  if (!p || p.kind !== 'pass') throw Object.assign(new Error(`${productId} is not a subscription`), { status: 400 });
  const cost = Math.ceil(p.price_cents / 100 / config().point_usd);
  return db.tx(async c => {
    await c.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]); // one spend at a time per account
    const have = await balance(accountId, c);
    if (have < cost) throw new NotEnoughPoints(have, cost);
    await c.query(`INSERT INTO reward_points (account_id, points, kind, source, ref, note) VALUES ($1, $2, 'spend', 'pass', $3, $4)`,
      [accountId, -cost, crypto.randomUUID(), `${p.title}`]);
    const { rows } = await c.query(
      `INSERT INTO passes (account_id, product, starts_at, ends_at)
       SELECT $1, $2, s, s + make_interval(days => $3)
       FROM (SELECT GREATEST(now(), COALESCE(MAX(ends_at), now())) AS s FROM passes WHERE account_id = $1 AND product = $2) t
       RETURNING product, starts_at, ends_at`,
      [accountId, productId, p.days],
    );
    return { pass: rows[0], points_spent: cost, balance: round4(have - cost) };
  });
}

/** What the Points page shows. */
async function overview(accountId) {
  const c = config();
  const [b, s, { rows }] = await Promise.all([
    balance(accountId), supply(),
    db.query('SELECT points, kind, source, fee_usd, note, created_at FROM reward_points WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100', [accountId]),
  ]);
  return {
    balance: b, value_usd: Math.round(b * c.point_usd * 100) / 100, point_usd: c.point_usd, rebate_pct: c.rebate_bps / 100,
    how: `You earn RektBull Points worth ${c.rebate_bps / 100}% of the trading fees you pay RektBull (swaps, perps, Polymarket trading fees and profit share), at $${c.point_usd} a point. Spend them on subscriptions. At most ${CAP.toLocaleString('en-US')} points will ever be issued; ${s.remaining.toLocaleString('en-US', { maximumFractionDigits: 0 })} remain.`,
    token_note: c.token_note,
    supply: s,
    subscriptions: passPrices(c),
    history: rows.map(r => ({ points: Number(r.points), kind: r.kind, source: SOURCES[r.source] || r.source, fee_usd: r.fee_usd === null ? null : Number(r.fee_usd), note: r.note, at: r.created_at })),
  };
}

/** Admin: the value, the rebate and the token wording. */
function checkSettings(input) {
  const out = {};
  if (input.point_usd !== undefined) {
    const v = Number(input.point_usd);
    if (!(v >= 0.001 && v <= 100)) throw Object.assign(new Error('point_usd must be $0.001 to $100.'), { status: 400 });
    out.point_usd = v;
  }
  if (input.rebate_bps !== undefined) {
    const v = Number(input.rebate_bps);
    if (!(Number.isInteger(v) && v >= 0 && v <= 10000)) throw Object.assign(new Error('rebate_bps must be a whole number from 0 to 10000 (100%).'), { status: 400 });
    out.rebate_bps = v;
  }
  if (input.token_note !== undefined) {
    const v = String(input.token_note).trim();
    if (v.length > 500) throw Object.assign(new Error('token_note must be at most 500 characters.'), { status: 400 });
    out.token_note = v;
  }
  return out;
}

module.exports = { CAP, DEFAULTS, SOURCES, config, pointsFor, credit, safeCredit, balance, supply, passPrices, buyPass, spend, overview, checkSettings, NotEnoughPoints };

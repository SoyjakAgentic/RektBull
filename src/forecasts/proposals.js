/**
 * AI proposals: a forecast offered to the users who asked for them. Offering
 * is free; acting on one ("Review the order") costs `proposal_usd` of Safety
 * Pro AI credits (the 30-day allowance first, then a top-up), charged once.
 * Nothing is traded here: approving a proposal opens the order for the user to
 * check and sign themselves, carrying RektBull's AI builder code.
 */
const crypto = require('crypto');
const db = require('../config/db');
const logger = require('../config/logger');
const passes = require('../payments/passes');
const aiAllowance = require('../payments/aiAllowance');
const aiTopups = require('../payments/aiTopups');

const VENUES = ['polymarket', 'hyperliquid'];

async function getSettings(accountId) {
  const { rows: [r] } = await db.query('SELECT polymarket, hyperliquid, max_per_day FROM ai_proposal_settings WHERE account_id = $1', [accountId]);
  return r || { polymarket: false, hyperliquid: false, max_per_day: 5 };
}

async function saveSettings(accountId, input) {
  const cur = await getSettings(accountId);
  const next = {
    polymarket: input.polymarket === undefined ? cur.polymarket : !!input.polymarket,
    hyperliquid: input.hyperliquid === undefined ? cur.hyperliquid : !!input.hyperliquid,
    max_per_day: input.max_per_day === undefined ? cur.max_per_day : Number(input.max_per_day),
  };
  if (!(Number.isInteger(next.max_per_day) && next.max_per_day >= 1 && next.max_per_day <= 50)) throw Object.assign(new Error('max_per_day must be 1 to 50.'), { status: 400 });
  await db.query(`INSERT INTO ai_proposal_settings (account_id, polymarket, hyperliquid, max_per_day) VALUES ($1, $2, $3, $4)
    ON CONFLICT (account_id) DO UPDATE SET polymarket = $2, hyperliquid = $3, max_per_day = $4, updated_at = now()`, [accountId, next.polymarket, next.hyperliquid, next.max_per_day]);
  return next;
}

/** The accounts that asked for this venue's proposals, with an active Safety Pro pass. */
async function subscribers(venue) {
  if (!VENUES.includes(venue)) throw new Error(`unknown venue ${venue}`);
  const { rows } = await db.query(`SELECT s.account_id, s.max_per_day,
      (SELECT COUNT(*) FROM ai_proposals p WHERE p.account_id = s.account_id AND p.created_at > now() - interval '24 hours')::int AS today
    FROM ai_proposal_settings s WHERE s.${venue} = true`);
  return rows.filter(r => r.today < r.max_per_day);
}

/**
 * Offers a forecast to one account, free; `priceUsd` is what acting on it
 * will cost. Returns the proposal, or null when the account has no Safety Pro
 * pass, no AI credits to act on it with, or has this forecast already.
 */
async function offer(accountId, { forecast, side, assetId = null, priceLimit = null, priceUsd }) {
  if (!(await canPay(accountId))) return null;
  const id = crypto.randomUUID();
  const { rows: [p] } = await db.query(
    `INSERT INTO ai_proposals (id, account_id, forecast_id, venue, market, side, asset_id, price_limit, price_usd, paid_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL) ON CONFLICT (account_id, forecast_id) DO NOTHING RETURNING *`,
    [id, accountId, forecast.id, forecast.venue, forecast.market, side, assetId, priceLimit, priceUsd],
  );
  if (!p) return null;
  logger.info('AI proposal offered', { account: accountId, forecast: forecast.id, venue: forecast.venue });
  return p;
}

/** Has this account a Safety Pro pass with AI credits left (the allowance, or a top-up)? */
async function canPay(accountId) {
  const pass = await passes.covering(accountId, 'token_report');
  if (!pass?.ai_allowance) return false;
  return (await aiAllowance.hasRoom(accountId, pass)) || (await aiTopups.hasRoom(accountId));
}

/**
 * Charges `usd` of AI credits for work already delivered (the automation fee
 * on a fill): the allowance first, then a top-up. Returns where it was paid
 * from, or null when neither had room (logged; the fill isn't undone).
 */
async function chargeCredits(accountId, usd, ref, note) {
  const pass = await passes.covering(accountId, 'token_report');
  if (pass?.ai_allowance && await aiAllowance.hasRoom(accountId, pass)) { await aiAllowance.charge(accountId, pass, usd); return 'allowance'; }
  if (await aiTopups.hasRoom(accountId)) { await aiTopups.use(accountId, usd, ref, note); return 'topup'; }
  logger.warn('AI credits ran out before a fee was charged', { account: accountId, usd, ref });
  return null;
}

const present = r => ({
  id: r.id, venue: r.venue, market: r.market, side: r.side, asset_id: r.asset_id, price_limit: r.price_limit === null ? null : Number(r.price_limit),
  price_usd: Number(r.price_usd), paid_from: r.paid_from, status: r.status, created_at: r.created_at,
  forecast: r.question === undefined ? undefined : {
    question: r.question, outcome: r.outcome, ai_prob: Number(r.ai_prob), market_prob: r.market_prob === null ? null : Number(r.market_prob),
    confidence: r.confidence, reasoning: r.reasoning, sources: r.sources, model: r.model, made_at: r.forecast_at,
  },
});

async function list(accountId) {
  const { rows } = await db.query(`SELECT p.*, f.question, f.outcome, f.ai_prob, f.market_prob, f.confidence, f.reasoning, f.sources, f.model, f.created_at AS forecast_at
    FROM ai_proposals p JOIN ai_forecasts f ON f.id = p.forecast_id WHERE p.account_id = $1 ORDER BY p.created_at DESC LIMIT 50`, [accountId]);
  return rows.map(present);
}

/**
 * Approving is acting on the proposal: its price is charged to AI credits,
 * once (the allowance first, then a top-up). Dismissing is free. Without AI
 * credits it can't be approved, and the user is pointed to a top-up.
 */
async function act(accountId, id, status) {
  if (!['approved', 'dismissed'].includes(status)) throw Object.assign(new Error('status must be approved or dismissed'), { status: 400 });
  if (status === 'approved' && !(await canPay(accountId))) {
    throw Object.assign(new Error('Acting on a proposal costs AI credits, and yours are used up: top up your AI credits on the Safety page.'), { status: 402, code: 'no_ai_credits' });
  }
  const { rows: [r] } = await db.query(`UPDATE ai_proposals SET status = $3, acted_at = now() WHERE id = $1 AND account_id = $2 AND status = 'offered' RETURNING *`, [id, accountId, status]);
  if (!r) throw Object.assign(new Error('Only an offered proposal can be approved or dismissed.'), { status: 409 });
  if (status === 'approved' && Number(r.price_usd) > 0) {
    const paidFrom = await chargeCredits(accountId, Number(r.price_usd), `proposal:${r.id}`, `AI proposal: ${r.market}`);
    await db.query('UPDATE ai_proposals SET paid_from = $2 WHERE id = $1', [r.id, paidFrom]);
    r.paid_from = paidFrom;
  }
  return present(r);
}

/** The approved proposal an order is being prepared from: the account's own, for its outcome, a buy. */
async function forOrder(accountId, id, input) {
  const refuse = m => { throw Object.assign(new Error(m), { status: 422, isOrderRefused: true, code: 'bad_proposal' }); };
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) refuse('No such proposal.');
  const { rows: [p] } = await db.query(`SELECT * FROM ai_proposals WHERE id = $1 AND account_id = $2 AND venue = 'polymarket'`, [id, accountId]);
  if (!p) refuse('No such proposal.');
  if (p.status !== 'approved') refuse('Approve the proposal first.');
  if (String(input.asset_id) !== String(p.asset_id)) refuse('That isn\'t the outcome the proposal is for.');
  if (String(input.side || '').toUpperCase() !== 'BUY') refuse('A proposal is a buy.');
  return p;
}

module.exports = { VENUES, getSettings, saveSettings, subscribers, offer, list, act, present, canPay, chargeCredits, forOrder };

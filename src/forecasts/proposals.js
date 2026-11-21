/**
 * AI proposals: a forecast offered to the users who asked for them, charged to
 * their Safety Pro AI credits (the 30-day allowance first, then a top-up).
 * Nothing is traded here: approving a proposal opens the order for the user to
 * check and sign themselves.
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
 * Offers a forecast to one account, charging `priceUsd` to its AI credits.
 * Returns the proposal, or null when the account has no Safety Pro pass, no
 * credits left, or has this forecast already.
 */
async function offer(accountId, { forecast, side, assetId = null, priceLimit = null, priceUsd }) {
  const pass = await passes.covering(accountId, 'token_report');
  if (!pass?.ai_allowance) return null;
  let paidFrom = null;
  if (await aiAllowance.hasRoom(accountId, pass)) paidFrom = 'allowance';
  else if (await aiTopups.hasRoom(accountId)) paidFrom = 'topup';
  if (!paidFrom) return null;
  const id = crypto.randomUUID();
  const { rows: [p] } = await db.query(
    `INSERT INTO ai_proposals (id, account_id, forecast_id, venue, market, side, asset_id, price_limit, price_usd, paid_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (account_id, forecast_id) DO NOTHING RETURNING *`,
    [id, accountId, forecast.id, forecast.venue, forecast.market, side, assetId, priceLimit, priceUsd, paidFrom],
  );
  if (!p) return null;
  // Charged once it's offered (the work is delivered); a proposal already had is never charged twice.
  if (paidFrom === 'allowance') await aiAllowance.charge(accountId, pass, priceUsd);
  else await aiTopups.use(accountId, priceUsd, `proposal:${id}`, `AI proposal: ${forecast.market}`);
  logger.info('AI proposal offered', { account: accountId, forecast: forecast.id, venue: forecast.venue });
  return p;
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

async function act(accountId, id, status) {
  if (!['approved', 'dismissed'].includes(status)) throw Object.assign(new Error('status must be approved or dismissed'), { status: 400 });
  const { rows: [r] } = await db.query(`UPDATE ai_proposals SET status = $3, acted_at = now() WHERE id = $1 AND account_id = $2 AND status = 'offered' RETURNING *`, [id, accountId, status]);
  if (!r) throw Object.assign(new Error('Only an offered proposal can be approved or dismissed.'), { status: 409 });
  return present(r);
}

module.exports = { VENUES, getSettings, saveSettings, subscribers, offer, list, act, present };

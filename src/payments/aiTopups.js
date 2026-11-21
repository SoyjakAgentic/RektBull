/**
 * Safety Pro AI top-ups: more AI usage on top of the pass's 30-day allowance
 * (payments/aiAllowance.js), for when it runs out before it resets.
 *
 * - Bought in fixed sizes, dollar for dollar: a $5 top-up adds $5 of AI usage,
 *   counted at what each run actually costs RektBull, like the allowance.
 * - Paid with credits (USDT/USDC top-ups or the crypto checkout) or with
 *   RektBull Points at the point's value.
 * - Used only after the 30-day allowance is used up, and only with an active
 *   Safety Pro pass; what's left never expires and waits for the next pass.
 * - Checked before a run and counted after it, like the allowance: the last
 *   run can take the balance at most one run's cost below zero.
 */
const crypto = require('crypto');
const db = require('../config/db');
const credits = require('./credits');

const SIZES_USD = [5, 20, 50];

class TopUpRefused extends Error {
  constructor(message, status = 400, code = 'bad_request') { super(message); this.status = status; this.code = code; }
}

async function balance(accountId, c = db) {
  const { rows: [r] } = await c.query('SELECT COALESCE(SUM(usd), 0) AS b FROM ai_topups WHERE account_id = $1', [accountId]);
  return Number(r.b);
}

const hasRoom = async accountId => (await balance(accountId)) > 0;

/** Counts a run's AI cost (or a proposal's price) against the top-up. */
async function use(accountId, usd, ref = crypto.randomUUID(), note = null) {
  if (!(usd > 0)) return;
  await db.query(`INSERT INTO ai_topups (account_id, usd, kind, ref, note) VALUES ($1, $2, 'use', $3, $4) ON CONFLICT (ref) DO NOTHING`, [accountId, -usd, String(ref), note]);
}

/** Buys a top-up of `usd` (one of SIZES_USD), paid with credits or points. */
async function buy(accountId, usd, payWith) {
  usd = Number(usd);
  if (!SIZES_USD.includes(usd)) throw new TopUpRefused(`A top-up is $${SIZES_USD.join(', $')}.`);
  const ref = `ai_topup:${crypto.randomUUID()}`;
  if (payWith === 'credits') {
    try { await credits.spend(accountId, usd * 100, 'ai_topup', ref); } catch (err) {
      if (err instanceof credits.InsufficientCredits) throw new TopUpRefused(`Not enough credits: this costs $${usd}. Add credits with USDT or USDC first.`, 402, 'insufficient_credits');
      throw err;
    }
  } else if (payWith === 'points') {
    const rewardPoints = require('../rewards/points');
    await rewardPoints.spend(accountId, Math.ceil(usd / rewardPoints.config().point_usd), { source: 'ai_topup', ref, note: `$${usd} AI top-up` });
  } else throw new TopUpRefused('pay_with must be credits or points.');
  await db.query(`INSERT INTO ai_topups (account_id, usd, kind, paid_with, ref, note) VALUES ($1, $2, 'topup', $3, $4, $5)`, [accountId, usd, payWith, ref, `$${usd} AI top-up`]);
  return { added_usd: usd, balance_usd: await balance(accountId), paid_with: payWith };
}

module.exports = { SIZES_USD, balance, hasRoom, use, buy, TopUpRefused };

/**
 * The payment gate in front of every paid run.
 *
 *   router.post('/v1/tokens/report', paidRoute('token_report', { validate, run }))
 *
 * It tries, in order: an x402 payment in X-PAYMENT; then, for a signed-in
 * wallet, an active Safety Pro pass that covers the product (within its fair
 * use, or what it includes a month), the month's free points, and credits.
 * If none applies it answers 402 with every way to pay.
 *
 * Nothing is kept unless the run succeeds: pass uses, points and credits are
 * given back, and an x402 payment is never settled, when the run throws.
 */
const crypto = require('crypto');
const db = require('../config/db');
const logger = require('../config/logger');
const { product, rails, usd, FREE_POINTS } = require('./catalog');
const points = require('./points');
const { ipSubject } = require('../privacy/ipKey');
const credits = require('./credits');
const passes = require('./passes');
const x402 = require('./x402');

const today = () => new Date().toISOString().slice(0, 10);

/** Uses one of the day's allowance for subject; false when it's used up. */
async function takeAllowance(subject, key, limit) {
  const { rows } = await db.query(
    `INSERT INTO free_usage (subject, product, day, count) VALUES ($1, $2, $3, 1)
     ON CONFLICT (subject, product, day) DO UPDATE SET count = free_usage.count + 1
     WHERE free_usage.count < $4 RETURNING count`,
    [subject, key, today(), limit],
  );
  return rows.length === 1;
}

const giveBackAllowance = (subject, key) =>
  db.query('UPDATE free_usage SET count = GREATEST(count - 1, 0) WHERE subject = $1 AND product = $2 AND day = $3', [subject, key, today()]);

function paymentRequired(p, req, extra = {}) {
  const resource = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const accepts = p.x402 && x402.enabled() ? [x402.requirements(p, resource)] : [];
  return {
    x402Version: x402.X402_VERSION,
    error: 'payment_required',
    message: `${p.title} costs ${usd(p.price_cents)}.`,
    accepts,
    pay_with: {
      x402: accepts.length ? 'Retry with an X-PAYMENT header (USDC on Base).' : null,
      credits: req.account ? 'Top up with USDT or USDC: POST /v1/invoices.' : 'Sign in with your wallet (POST /v1/auth/nonce), then top up with USDT or USDC.',
      ...(p.points ? { points: req.account ? `This month's free points are used up (it costs ${p.points}).` : `Sign in with your wallet for ${FREE_POINTS.per_month} free points a month (this costs ${p.points}).` } : {}),
      safety_pro: 'Safety Pro covers it: POST /v1/passes/pro_30d ($9 for 30 days).',
    },
    ...extra,
  };
}

/** Finds a way to pay; returns a charge { method, commit(), rollback() } or null. */
async function acquire(p, req, runId) {
  const header = req.get('x-payment');
  if (header) {
    if (!p.x402 || !x402.enabled()) throw Object.assign(new Error('This product does not take x402 payments'), { status: 400 });
    const resource = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const accepted = await x402.accept(header, x402.requirements(p, resource));
    return { method: 'x402', payer: accepted.payer, commit: accepted.settle, rollback: async () => {} };
  }
  const acct = req.account;
  if (!acct) return null;
  const subject = `account:${acct.id}`;
  for (const rail of rails(p)) {
    if (rail === 'pass') {
      const pass = await passes.covering(acct.id, p.id);
      if (pass?.included_per_month) {
        if (await points.takeIncluded(acct.id, p.id, pass.included_per_month)) {
          return { method: 'pass', commit: async () => {}, rollback: () => points.giveBackIncluded(acct.id, p.id) };
        }
      } else if (pass && pass.fair_use_per_day && await takeAllowance(subject, `${p.id}:pass`, pass.fair_use_per_day)) {
        return { method: 'pass', commit: async () => {}, rollback: () => giveBackAllowance(subject, `${p.id}:pass`) };
      }
    } else if (rail === 'points') {
      // A cap per IP address too, so many new wallets from one place can't farm points.
      const ipKey = 'points_ip';
      if (await takeAllowance(ipSubject(req.ip), ipKey, FREE_POINTS.per_ip_per_day)) {
        if (await points.spend(acct, p.points)) {
          return { method: 'points', points: p.points, commit: async () => {}, rollback: async () => { await points.refund(acct, p.points); await giveBackAllowance(ipSubject(req.ip), ipKey); } };
        }
        await giveBackAllowance(ipSubject(req.ip), ipKey);
      }
    } else if (rail === 'credits') {
      try {
        await credits.spend(acct.id, p.price_cents, 'run', `run:${runId}`);
        return { method: 'credits', commit: async () => {}, rollback: () => credits.refund(acct.id, p.price_cents, runId) };
      } catch (err) {
        if (!(err instanceof credits.InsufficientCredits)) throw err;
      }
    }
  }
  return null;
}

/**
 * record(input) chooses what of the input is kept with the run (default: all
 * of it). The pre-sign check keeps only the method and chain, not what was
 * being signed or where.
 */
function paidRoute(productId, { validate, run, record = input => input }) {
  const p = product(productId);
  return async (req, res) => {
    const input = validate(req);
    if (input.error) return res.status(400).json({ error: 'bad_request', message: input.error });

    const runId = crypto.randomUUID();
    let charge;
    try {
      charge = await acquire(p, req, runId);
    } catch (err) {
      if (err.isPaymentInvalid) return res.status(402).json(paymentRequired(p, req, { payment_error: err.message }));
      throw err;
    }
    if (!charge) {
      const balance = req.account ? await credits.balance(req.account.id) : null;
      return res.status(402).json(paymentRequired(p, req, balance === null ? {} : { credits_balance_cents: balance }));
    }

    await db.query(
      'INSERT INTO runs (id, account_id, product, payment_method, price_cents, input, x402_payer) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [runId, req.account?.id || null, p.id, charge.method, charge.method === 'credits' || charge.method === 'x402' ? p.price_cents : 0, JSON.stringify(record(input)), charge.payer || null],
    );

    let result;
    try {
      result = await run(input, req);
    } catch (err) {
      await charge.rollback().catch(e => logger.error('could not give a failed run back', { run: runId, error: e.message }));
      await db.query(`UPDATE runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [runId, err.message]);
      throw err;
    }

    let settled = null;
    try {
      settled = await charge.commit();
    } catch (err) {
      await db.query(`UPDATE runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [runId, `settlement: ${err.message}`]);
      return res.status(402).json(paymentRequired(p, req, { payment_error: `The payment could not be settled: ${err.message}` }));
    }
    await db.query(`UPDATE runs SET status = 'succeeded', x402_tx = $2, finished_at = now() WHERE id = $1`, [runId, settled?.txHash || null]);
    if (settled?.header) res.set('X-PAYMENT-RESPONSE', settled.header);
    res.json({ ...result, run: { id: runId, paid_with: charge.method, ...(charge.method === 'credits' || charge.method === 'x402' ? { price_cents: p.price_cents } : {}), ...(charge.points ? { points: charge.points } : {}) } });
  };
}

module.exports = { paidRoute, acquire, paymentRequired, takeAllowance };

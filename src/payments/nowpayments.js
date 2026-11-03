/**
 * NOWPayments: a second way to top up credits or buy a pass (carried over
 * from soyjak-agentic's services/nowPayments.js).
 *
 * RektBull's own top-ups give each account a deposit address and watch the
 * chain (watcher.js): no fee, but only USDT/USDC on the payment chains, and
 * a deposit address holding USDT needs gas sent to it before it can be
 * swept. With NOWPayments the buyer pays on its hosted invoice page in
 * whichever coin and network is enabled in the NOWPayments dashboard, and it
 * forwards the payment to RektBull's payout wallet (set there, a Safe). It
 * charges a fee per payment. This is RektBull's own revenue moving, never a
 * user's funds: nothing here can touch a user's wallet.
 *
 * Nothing is credited on a notification's word:
 *   - the notification (IPN) must carry a valid HMAC-SHA512 signature, over
 *     the body with its keys sorted, with the IPN secret;
 *   - the payment is then read back from NOWPayments' API with the API key;
 *   - it must be this invoice's (order id, and NOWPayments' invoice id), for
 *     at least its price in US dollars, and 'finished' (forwarded);
 *   - crediting is one ledger entry with a unique ref, so a notification and
 *     the 5-minute re-check can't credit it twice.
 * Statuses: finished credits; partially_paid is 'underpaid' (nothing is
 * credited automatically: an admin sees it and decides); failed, expired and
 * refunded expire; waiting (a coin picked, nothing sent) changes nothing;
 * everything else (seen, on its way) is 'confirming'.
 *
 * Field names are from NOWPayments' API documentation; check them against it
 * when setting up (docs/PAYMENTS.md). The sandbox is chosen with
 * NOWPAYMENTS_API_BASE.
 */
const crypto = require('crypto');
const axios = require('axios');
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const { track } = require('../providers/usage');
const { product } = require('./catalog');
const credits = require('./credits');
const passes = require('./passes');

class NowPaymentsError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** https, on nowpayments.io (the live API or the sandbox), nothing else. */
function isNowPaymentsUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && (u.hostname === 'nowpayments.io' || u.hostname.endsWith('.nowpayments.io'));
  } catch { return false; }
}

/** { apiKey, ipnSecret, baseUrl }, or null when it isn't set up. */
function config() {
  const baseUrl = String(env.nowpaymentsApiBase || 'https://api.nowpayments.io/v1').replace(/\/+$/, '');
  if (!isNowPaymentsUrl(baseUrl)) {
    // Credits are granted on what this URL reports, so it's NOWPayments' or nothing.
    logger.error('NOWPAYMENTS_API_BASE is not an https nowpayments.io address: NOWPayments is off');
    return null;
  }
  return env.nowpaymentsApiKey && env.nowpaymentsIpnSecret ? { apiKey: env.nowpaymentsApiKey, ipnSecret: env.nowpaymentsIpnSecret, baseUrl } : null;
}

const enabled = () => env.nowpaymentsEnabled && !!config();

/** Keys sorted at every level, as NOWPayments signs them. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, k) => { out[k] = sortKeys(value[k]); return out; }, {});
  return value;
}

function verifyIpn(body, signature) {
  const cfg = config();
  if (!cfg || !body || typeof body !== 'object') return false;
  const expected = crypto.createHmac('sha512', cfg.ipnSecret).update(JSON.stringify(sortKeys(body))).digest('hex');
  const a = Buffer.from(expected, 'utf8'); const b = Buffer.from(String(signature || '').toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** What a NOWPayments status means here. */
function outcome(status) {
  switch (String(status || '')) {
    case 'finished': return 'paid';
    case 'partially_paid': return 'underpaid';
    case 'failed': case 'expired': case 'refunded': return 'expired';
    case 'waiting': return 'started';
    default: return 'confirming'; // confirming, confirmed, sending, and anything new
  }
}

// The HTTP call, on its own so tests can stand in for NOWPayments.
const http = { request: req => axios(req) };

async function api(method, path, body) {
  const cfg = config();
  if (!cfg) throw new NowPaymentsError('NOWPayments is not set up.', 503);
  return track('nowpayments', async () => (await http.request({ method, url: `${cfg.baseUrl}${path}`, data: body, headers: { 'x-api-key': cfg.apiKey, 'content-type': 'application/json' }, timeout: 15000 })).data);
}

const present = r => ({
  id: r.id, gateway: 'nowpayments', status: r.status, amount_cents: r.amount_cents, product: r.product,
  invoice_url: r.invoice_url, pay_currency: r.pay_currency, created_at: r.created_at, paid_at: r.paid_at,
  note: r.status === 'underpaid' ? 'NOWPayments says less than the price arrived. Nothing was credited automatically; write to us and we\'ll sort it out.' : undefined,
});

/** A hosted invoice for a top-up (amount_cents) or a pass (product). Returns where to pay. */
async function createCheckout(accountId, { amount_cents, product: productId } = {}) {
  if (!enabled()) throw new NowPaymentsError('Paying through NOWPayments isn\'t available yet. Top up with USDT or USDC instead.', 503);
  let cents = Number(amount_cents) || 0;
  let description = 'RektBull credits';
  if (productId) {
    const p = product(productId);
    if (p.kind !== 'pass') throw new NowPaymentsError('only credits and passes can be bought this way');
    cents = p.price_cents;
    description = p.title;
  }
  if (!Number.isInteger(cents) || cents < env.minTopUpCents) throw new NowPaymentsError(`the smallest top-up is $${(env.minTopUpCents / 100).toFixed(2)}`);
  if (cents > 1000000) throw new NowPaymentsError('the largest top-up here is $10,000');
  const id = crypto.randomUUID();
  await db.query('INSERT INTO hosted_invoices (id, account_id, gateway, amount_cents, product) VALUES ($1, $2, $3, $4, $5)', [id, accountId, 'nowpayments', cents, productId || null]);
  let data;
  try {
    data = await api('post', '/invoice', {
      price_amount: cents / 100, price_currency: 'usd', order_id: id, order_description: description,
      ipn_callback_url: `${env.publicUrl}/v1/nowpayments/ipn`,
      success_url: `${env.publicUrl}/safety?paid=${id}#account-card`, cancel_url: `${env.publicUrl}/safety#account-card`,
    });
  } catch (err) {
    await db.query(`UPDATE hosted_invoices SET status = 'expired', updated_at = now() WHERE id = $1`, [id]);
    throw err instanceof NowPaymentsError ? err : new NowPaymentsError(`NOWPayments couldn't make the invoice (${err.response?.data?.message || err.message}).`, 502);
  }
  if (!data?.id || !/^https:\/\//.test(String(data.invoice_url || '')) || String(data.order_id ?? id) !== id) {
    await db.query(`UPDATE hosted_invoices SET status = 'expired', updated_at = now() WHERE id = $1`, [id]);
    throw new NowPaymentsError('NOWPayments didn\'t return an invoice for this order.', 502);
  }
  const { rows } = await db.query(`UPDATE hosted_invoices SET np_invoice_id = $2, invoice_url = $3, updated_at = now() WHERE id = $1 RETURNING *`, [id, String(data.id), data.invoice_url]);
  return present(rows[0]);
}

async function get(accountId, id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new NowPaymentsError('not found', 404);
  const { rows } = await db.query('SELECT * FROM hosted_invoices WHERE id = $1 AND account_id = $2', [id, accountId]);
  if (!rows.length) throw new NowPaymentsError('not found', 404);
  return present(rows[0]);
}

/**
 * Applies a payment, as read back from NOWPayments, to its invoice. Credits
 * (and buys the pass) at most once. Returns what was done.
 */
async function applyPayment(inv, payment) {
  if (!inv) return 'unknown order';
  if (String(payment?.order_id) !== inv.id) return 'not this invoice';
  if (inv.np_invoice_id && payment.invoice_id != null && String(payment.invoice_id) !== inv.np_invoice_id) return 'not this invoice';
  const what = outcome(payment.payment_status);
  const paymentId = payment.payment_id != null ? String(payment.payment_id) : null;
  const coin = payment.pay_currency ? String(payment.pay_currency).toUpperCase().slice(0, 32) : null;
  await db.query('UPDATE hosted_invoices SET np_payment_id = COALESCE($2, np_payment_id), pay_currency = COALESCE($3, pay_currency), updated_at = now() WHERE id = $1', [inv.id, paymentId, coin]);
  if (what === 'paid') {
    const priced = String(payment.price_currency || '').toLowerCase() === 'usd' && Math.round(Number(payment.price_amount) * 100) >= inv.amount_cents;
    if (!priced) {
      logger.error('NOWPayments payment priced differently from its invoice: not credited', { invoice: inv.id, payment: paymentId, price: payment.price_amount, currency: payment.price_currency });
      return 'mispriced';
    }
    const credited = await credits.add(inv.account_id, inv.amount_cents, 'deposit', `nowpayments:${inv.id}`);
    await db.query(`UPDATE hosted_invoices SET status = 'paid', paid_at = COALESCE(paid_at, now()), updated_at = now() WHERE id = $1`, [inv.id]);
    if (credited && inv.product) {
      try { await passes.buy(inv.account_id, inv.product, `nowpayments:${inv.id}`); } catch (err) {
        logger.error('NOWPayments invoice paid but its pass was not bought (the credits are there)', { invoice: inv.id, error: err.message });
      }
    }
    return credited ? 'credited' : 'already credited';
  }
  if (what === 'underpaid') {
    await db.query(`UPDATE hosted_invoices SET status = 'underpaid', updated_at = now() WHERE id = $1 AND status IN ('pending', 'confirming', 'expired')`, [inv.id]);
    return 'underpaid';
  }
  if (what === 'expired') {
    await db.query(`UPDATE hosted_invoices SET status = 'expired', updated_at = now() WHERE id = $1 AND status IN ('pending', 'confirming')`, [inv.id]);
    return 'expired';
  }
  if (what === 'started') return 'started';
  await db.query(`UPDATE hosted_invoices SET status = 'confirming', updated_at = now() WHERE id = $1 AND status IN ('pending', 'expired')`, [inv.id]);
  return 'confirming';
}

/** The notification: signature, then the invoice it names, then the payment read back from the API. */
async function handleIpn(body, signature) {
  if (!verifyIpn(body, signature)) return { status: 401, result: 'bad signature' };
  if (!/^[0-9a-f-]{36}$/.test(String(body.order_id || ''))) return { status: 200, result: 'no order' };
  if (!/^\d{1,30}$/.test(String(body.payment_id || ''))) return { status: 200, result: 'no payment' };
  const { rows: [inv] } = await db.query(`SELECT * FROM hosted_invoices WHERE id = $1 AND gateway = 'nowpayments'`, [body.order_id]);
  if (!inv) return { status: 200, result: 'unknown order' };
  const payment = await api('get', `/payment/${body.payment_id}`);
  return { status: 200, result: await applyPayment(inv, payment) };
}

/**
 * Every 5 minutes (worker): invoices with a payment under way, read back by
 * payment id, so a lost notification is caught up. Ones still pending or
 * past their expiry are re-checked for a day.
 */
async function reconcile() {
  if (!config()) return { checked: 0 };
  const { rows } = await db.query(
    `SELECT * FROM hosted_invoices WHERE gateway = 'nowpayments' AND np_payment_id IS NOT NULL
       AND (status = 'confirming' OR (status IN ('pending', 'expired') AND created_at > now() - interval '1 day'))
     ORDER BY updated_at LIMIT 100`);
  let checked = 0;
  for (const inv of rows) {
    try { await applyPayment(inv, await api('get', `/payment/${inv.np_payment_id}`)); checked++; } catch (err) {
      logger.warn('NOWPayments re-check failed', { invoice: inv.id, error: err.message });
    }
  }
  await db.query(`UPDATE hosted_invoices SET status = 'expired', updated_at = now() WHERE status = 'pending' AND np_payment_id IS NULL AND created_at < now() - interval '1 day'`);
  return { checked };
}

module.exports = { http, NowPaymentsError, isNowPaymentsUrl, config, enabled, sortKeys, verifyIpn, outcome, createCheckout, get, applyPayment, handleIpn, reconcile };

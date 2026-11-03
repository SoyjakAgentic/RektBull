/**
 * NOWPayments: nothing is credited on a notification's word (signature, then
 * the payment read back from the API, then this invoice's, priced right and
 * finished), and nothing is credited twice. With a database, through the API;
 * NOWPayments itself is a stand-in.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, {
  NOWPAYMENTS_ENABLED: 'true', NOWPAYMENTS_API_KEY: 'np-key', NOWPAYMENTS_IPN_SECRET: 'np-secret', JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '',
  PUBLIC_URL: 'https://rektbull.example', ...(DB ? { DATABASE_URL: DB } : {}),
});
const np = require('../src/payments/nowpayments');
const sign = body => crypto.createHmac('sha512', 'np-secret').update(JSON.stringify(np.sortKeys(body))).digest('hex');

test('only https nowpayments.io; statuses; the signature is over the body with its keys sorted', () => {
  assert.ok(np.isNowPaymentsUrl('https://api.nowpayments.io/v1'));
  assert.ok(np.isNowPaymentsUrl('https://api-sandbox.nowpayments.io/v1'));
  for (const bad of ['http://api.nowpayments.io', 'https://nowpayments.io.evil.example', 'https://evilnowpayments.io', 'https://u:p@api.nowpayments.io']) assert.ok(!np.isNowPaymentsUrl(bad), bad);
  assert.deepEqual(['finished', 'partially_paid', 'expired', 'refunded', 'waiting', 'confirming', 'sending'].map(np.outcome), ['paid', 'underpaid', 'expired', 'expired', 'started', 'confirming', 'confirming']);
  const body = { payment_status: 'finished', order_id: 'x', a: { z: 1, b: 2 } };
  assert.equal(np.verifyIpn(body, sign({ a: { b: 2, z: 1 }, order_id: 'x', payment_status: 'finished' })), true, 'key order doesn\'t matter');
  assert.equal(np.verifyIpn({ ...body, payment_status: 'failed' }, sign(body)), false, 'a changed body fails');
  assert.equal(np.verifyIpn(body, undefined), false);
});

test('checkout, notifications and the re-check, through the API', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  const { createApp } = require('../src/app');
  const { issueToken } = require('../src/auth/siwe');
  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', ['0x' + 'ab'.repeat(20)]);
  const token = issueToken(acct);
  const balance = async () => (await call(token, 'GET', '/v1/credits')).body;

  // NOWPayments, played here: invoices it makes, and payments it reports.
  const sent = []; const payments = {};
  np.http.request = async req => {
    sent.push(req);
    if (req.method === 'post' && req.url.endsWith('/invoice')) return { data: { id: 'np-inv-' + sent.length, order_id: req.data.order_id, invoice_url: `https://nowpayments.io/payment/?iid=${sent.length}` } };
    const id = req.url.split('/payment/')[1];
    if (payments[id]) return { data: payments[id] };
    throw new Error('no such payment');
  };

  assert.equal((await call(null, 'GET', '/v1/payment-methods')).body.nowpayments.enabled, true);
  const c = await call(token, 'POST', '/v1/checkout/nowpayments', { amount_cents: 2500 });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.match(c.body.invoice_url, /^https:\/\/nowpayments\.io\//);
  const asked = sent[0].data;
  assert.deepEqual([asked.price_amount, asked.price_currency, asked.order_id], [25, 'usd', c.body.id]);
  assert.equal(asked.ipn_callback_url, 'https://rektbull.example/v1/nowpayments/ipn');
  assert.equal(sent[0].headers['x-api-key'], 'np-key');
  assert.equal((await call(token, 'POST', '/v1/checkout/nowpayments', { amount_cents: 100 })).status, 400, 'below the minimum top-up');
  assert.equal((await call(null, 'POST', '/v1/checkout/nowpayments', { amount_cents: 2500 })).status, 401);

  const ipn = body => call(null, 'POST', '/v1/nowpayments/ipn', body, { 'x-nowpayments-sig': sign(body) });
  const note = (id, payment_id, status) => ({ order_id: id, payment_id, payment_status: status, price_amount: 25, price_currency: 'usd' });

  // A forged notification: refused, and nothing is read or credited.
  const forged = await call(null, 'POST', '/v1/nowpayments/ipn', note(c.body.id, '111', 'finished'), { 'x-nowpayments-sig': 'ab'.repeat(64) });
  assert.equal(forged.status, 401);

  // A signed notification saying "finished", but NOWPayments' API says it's still confirming: not credited.
  payments['111'] = { payment_id: 111, order_id: c.body.id, invoice_id: 'np-inv-1', payment_status: 'confirming', price_amount: 25, price_currency: 'usd', pay_currency: 'btc' };
  assert.equal((await ipn(note(c.body.id, '111', 'finished'))).body.result, 'confirming', 'the API\'s word, not the notification\'s');
  assert.equal((await balance()).balance_cents, 0);

  // The re-check, once NOWPayments says it's finished: credited once.
  payments['111'].payment_status = 'finished';
  await np.reconcile();
  assert.equal((await balance()).balance_cents, 2500);
  assert.equal((await ipn(note(c.body.id, '111', 'finished'))).body.result, 'already credited', 'never twice');
  assert.equal((await balance()).balance_cents, 2500);
  const status = await call(token, 'GET', `/v1/checkout/${c.body.id}`);
  assert.deepEqual([status.body.status, status.body.pay_currency], ['paid', 'BTC']);

  // A pass: credited, then bought from those credits.
  const p = await call(token, 'POST', '/v1/checkout/nowpayments', { product: 'pro_30d' });
  const passInv = (await db.query('SELECT np_invoice_id FROM hosted_invoices WHERE id = $1', [p.body.id])).rows[0].np_invoice_id;
  payments['222'] = { payment_id: 222, order_id: p.body.id, invoice_id: passInv, payment_status: 'finished', price_amount: 9, price_currency: 'usd', pay_currency: 'sol' };
  assert.equal((await ipn({ ...note(p.body.id, '222', 'finished'), price_amount: 9 })).body.result, 'credited');
  const me = await call(token, 'GET', '/v1/me');
  assert.equal(me.body.passes[0].product, 'pro_30d', 'the pass is active');
  assert.equal((await balance()).balance_cents, 2500, '$9 in, $9 spent on the pass');

  // Refused: another order's payment, a cheaper price, an underpayment.
  const q = await call(token, 'POST', '/v1/checkout/nowpayments', { amount_cents: 5000 });
  const npInv = (await db.query('SELECT np_invoice_id FROM hosted_invoices WHERE id = $1', [q.body.id])).rows[0].np_invoice_id;
  payments['333'] = { payment_id: 333, order_id: c.body.id, payment_status: 'finished', price_amount: 50, price_currency: 'usd' };
  assert.equal((await ipn(note(q.body.id, '333', 'finished'))).body.result, 'not this invoice');
  payments['444'] = { payment_id: 444, order_id: q.body.id, invoice_id: npInv, payment_status: 'finished', price_amount: 5, price_currency: 'usd' };
  assert.equal((await ipn(note(q.body.id, '444', 'finished'))).body.result, 'mispriced');
  payments['555'] = { payment_id: 555, order_id: q.body.id, invoice_id: npInv, payment_status: 'partially_paid', price_amount: 50, price_currency: 'usd' };
  assert.equal((await ipn(note(q.body.id, '555', 'partially_paid'))).body.result, 'underpaid');
  assert.match((await call(token, 'GET', `/v1/checkout/${q.body.id}`)).body.note, /Nothing was credited automatically/);
  assert.equal((await balance()).balance_cents, 2500);
});

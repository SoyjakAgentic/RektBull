/**
 * The NOWPayments buttons on /safety, in a real browser: a top-up and a
 * pass go to NOWPayments' page, and coming back shows what happened. The
 * server is real; NOWPayments is a stand-in. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/nowpayments.js
 */
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', NOWPAYMENTS_ENABLED: 'true', NOWPAYMENTS_API_KEY: 'k', NOWPAYMENTS_IPN_SECRET: 's', PAYMENT_CHAINS: 'base' });

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  const np = require('../../src/payments/nowpayments');
  const asked = [];
  np.http.request = async req => { asked.push(req.data); return { data: { id: 'np-' + asked.length, order_id: req.data.order_id, invoice_url: `https://nowpayments.io/payment/?iid=${asked.length}` } }; };
  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', ['0x' + 'cd'.repeat(20)]);
  const token = require('../../src/auth/siwe').issueToken(acct);

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const visited = [];
  await page.route('https://nowpayments.io/**', r => { visited.push(r.request().url()); r.fulfill({ status: 200, contentType: 'text/html', body: '<p>NOWPayments (stand-in)</p>' }); });
  await page.addInitScript(([t, w]) => { sessionStorage.setItem('rb_token', t); sessionStorage.setItem('rb_wallet', w); }, [token, acct.wallet]);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(url + '/safety');
    await page.getByRole('button', { name: 'Pay with any coin (NOWPayments)' }).waitFor();
    assert.ok(await page.locator('#t-np-note', { hasText: 'charges a fee per payment' }).isVisible());
    await page.fill('#t-amount', '25');
    await page.getByRole('button', { name: 'Pay with any coin (NOWPayments)' }).click();
    await page.waitForURL(/nowpayments\.io/);
    assert.deepEqual([asked[0].price_amount, asked[0].price_currency], [25, 'usd']);
    console.log('✔ a $25 top-up goes to NOWPayments\' page');

    await page.goto(url + '/safety');
    await page.getByRole('button', { name: /or pay \$9\.00 with any coin \(30 days\)/ }).click();
    await page.waitForURL(/nowpayments\.io/);
    assert.equal(asked[1].price_amount, 9);
    assert.equal(asked[1].order_description, 'Safety Pro, 30 days');
    console.log('✔ a pass can be paid for directly, at its price');

    // Coming back: confirming, then paid.
    const { rows: [inv] } = await db.query('SELECT id FROM hosted_invoices ORDER BY created_at LIMIT 1');
    await db.query(`UPDATE hosted_invoices SET status = 'confirming' WHERE id = $1`, [inv.id]);
    await page.goto(`${url}/safety?paid=${inv.id}#account-card`);
    await page.locator('#topup-msg', { hasText: 'confirming it' }).waitFor();
    await db.query(`UPDATE hosted_invoices SET status = 'paid' WHERE id = $1`, [inv.id]);
    await page.goto(`${url}/safety?paid=${inv.id}#account-card`);
    await page.locator('#topup-msg', { hasText: 'Paid: it\'s in your credits' }).waitFor();
    console.log('✔ back from NOWPayments, the page says where the payment is');
    assert.deepEqual(errors, []);
    console.log('all passed');
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

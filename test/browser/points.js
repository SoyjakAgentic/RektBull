/**
 * The Points page in a real Chromium: a signed-in account with points earned
 * from a fee sees its balance, the cap, the token wording and its history,
 * and buys a subscription with points. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/points.js [screenshot.png]
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');
const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '' });

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  const points = require('../../src/rewards/points');
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', ['0x' + '12'.repeat(20)]);
  await points.credit({ accountId: acct.id, source: 'perps', ref: 'fill-1', feeUsd: 40 }); // 100 points
  await points.credit({ accountId: acct.id, source: 'polymarket_profit', ref: 'batch-1', feeUsd: 2 }); // 5 points
  const token = require('../../src/auth/siwe').issueToken(acct);
  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(([t, w]) => { sessionStorage.setItem('rb_token', t); sessionStorage.setItem('rb_wallet', w); }, [token, acct.wallet]);
  page.on('dialog', d => d.accept());
  try {
    await page.goto(url + '/points');
    await page.locator('#balance', { hasText: '105 points' }).waitFor();
    assert.match(await page.textContent('#balance'), /\$10\.50/);
    assert.match(await page.textContent('#token-note'), /convertible 1:1 for a RektBull utility token/);
    assert.match(await page.textContent('#supply'), /of 1,000,000,000 RektBull Points issued/);
    assert.match(await page.textContent('#history'), /Hyperliquid perps fee[\s\S]*\+100/);
    if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: true });
    await page.locator('#subs tr', { hasText: 'Safety Pro, 30 days' }).getByRole('button', { name: 'Buy with points' }).click();
    await page.locator('#spend-msg', { hasText: 'is active until' }).waitFor();
    assert.match(await page.textContent('#balance'), /15 points/);
    const { rows } = await db.query("SELECT product FROM passes WHERE account_id = $1", [acct.id]);
    assert.deepEqual(rows.map(r => r.product), ['pro_30d']);
    assert.deepEqual(errors, []);
    console.log('ok: the Points page');
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

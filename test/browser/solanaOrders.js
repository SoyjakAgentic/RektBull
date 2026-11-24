/**
 * The Solana orders card on /trade in a real Chromium, signed in with a
 * stand-in Solana wallet (Wallet Standard). The order service is a stand-in
 * here (test/solanaOrders.test.js runs the real one): this checks the page:
 * the reason it's off, the worst case shown before anything is signed, the
 * order placed from the wallet, and cancelling.
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/solanaOrders.js [screenshot.png]
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', TRADING_ENABLED: 'true' });
const USER = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const TOKEN = 'Ce9JBbxPQx2cAJjhFi9NEkmqGJGTVFBTHmYSGFTwpump';
const SIGNATURE = '5'.repeat(88);

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();

  const orders = require('../../src/trade/solanaOrders');
  let enabled = false;
  const calls = [];
  const open = { id: 7, kind: 'stop_loss', kind_name: 'Stop-loss', state: 'open', token: TOKEN, symbol: 'BULL', amount_whole: 1000, sold_whole: 0, floor_sol: '0.594', trigger_sol: '0.8', value_when_placed_sol: '1', delivered_sol: '0', last_error: null, order_url: 'https://solscan.io/account/x' };
  let listed = [];
  orders.list = async () => ({ enabled, ...(enabled ? {} : { why: 'Orders on Solana open once RektBull\'s order program has been audited and deployed. Until then, sell from your own wallet on the Trade desk.' }), orders: listed });
  orders.prepare = async (_a, body) => {
    calls.push(['prepare', body]);
    return {
      order: { ...open, id: 8, state: 'prepared' }, terms: { stop_pct: body.stop_pct, floor_pct: body.floor_pct },
      worst_case: ['Worst case, even if RektBull were hacked: your 1,000 BULL are sold for 0.594 SOL after the 1% fee (your floor), at a moment RektBull picks before 2026-12-24, even if the market is higher then.', 'Nothing else of yours can be touched.'],
      notes: [], costs: { order_deposit_sol: '0.00218544', order_deposit_note: 'Returned to you when it is filled or cancelled.', fee: 'RektBull\'s 1% of the SOL a fill brings.' },
      checks: [{ check: 'route', detail: 'they would sell for 1 SOL now', source: 'Jupiter quote' }],
      solana: { transaction: Buffer.from([1, 2, 3]).toString('base64') },
    };
  };
  let confirms = 0;
  orders.confirm = async (_a, id) => { calls.push(['confirm', Number(id)]); confirms++; if (confirms === 1) return { waiting: true }; listed = [open]; return { ...open, id: Number(id) }; };
  orders.cancel = async (_a, id) => { calls.push(['cancel', Number(id)]); return { order: open, revokes_approval: true, solana: { transaction: Buffer.from([4, 5]).toString('base64') } }; };
  orders.refresh = async (_a, id) => { calls.push(['refresh', Number(id)]); listed = [{ ...open, state: 'cancelled' }]; return { ...open, state: 'cancelled' }; };

  const { rows: [acct] } = await db.query('INSERT INTO accounts (solana_wallet) VALUES ($1) RETURNING id, wallet, solana_wallet', [USER]);
  const token = require('../../src/auth/siwe').issueToken(acct);
  const app = require('../../src/app').createApp().listen(0);
  const base = `http://127.0.0.1:${app.address().port}`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => r.continue({ headers: { ...r.request().headers(), 'cache-control': 'no-cache' } }));
  await page.addInitScript(([t, w, sig]) => {
    sessionStorage.setItem('rb_token', t); sessionStorage.setItem('rb_wallet', w); sessionStorage.setItem('rb_kind', 'solana');
    const account = { address: w, publicKey: new Uint8Array(32), chains: ['solana:mainnet'], features: [] };
    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const fromB58 = s => { let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c)); const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; } return new Uint8Array(out); };
    window.signed = [];
    const wallet = {
      version: '1.0.0', name: 'Test Solana', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', chains: ['solana:mainnet'], accounts: [],
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
        'solana:signMessage': { version: '1.0.0', signMessage: async () => { throw new Error('not in this test'); } },
        'solana:signAndSendTransaction': { version: '1.0.0', signAndSendTransaction: async input => { window.signed.push(Array.from(input.transaction)); return [{ signature: fromB58(sig) }]; } },
      },
    };
    const register = api => api.register(wallet);
    window.addEventListener('wallet-standard:app-ready', e => register(e.detail));
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
  }, [token, USER, SIGNATURE]);

  try {
    // Off: the card says why, and nothing can be prepared.
    await page.goto(`${base}/trade?chain=solana&token=${TOKEN}`);
    await page.click('#wallets button:has-text("Test Solana")');
    await page.locator('#sol-orders-card').waitFor();
    await page.locator('#so-off').waitFor();
    assert.match(await page.textContent('#so-off'), /open once RektBull's order program has been audited and deployed/);
    assert.equal(await page.isDisabled('#so-prepare'), true);
    assert.equal(await page.inputValue('#so-token'), TOKEN, 'the coin from the link');

    // On: the worst case first, then the wallet places it.
    enabled = true;
    await page.reload();
    await page.click('#wallets button:has-text("Test Solana")');
    await page.locator('#so-list td').first().waitFor();
    assert.equal(await page.isDisabled('#so-prepare'), false);
    assert.match(await page.textContent('#so-explain'), /never below your floor/);
    await page.selectOption('#so-kind', 'take_profit');
    assert.equal(await page.isVisible('#so-take-wrap'), true);
    assert.equal(await page.isVisible('#so-floor-wrap'), false);
    await page.selectOption('#so-kind', 'stop_loss');
    await page.fill('#so-stop', '20');
    await page.fill('#so-floor', '40');
    await page.click('#so-prepare');
    await page.locator('#so-plan:not([hidden])').waitFor();
    assert.match(await page.textContent('#so-plan'), /Worst case, even if RektBull were hacked: your 1,000 BULL are sold for 0\.594 SOL/);
    assert.deepEqual(calls[0], ['prepare', { kind: 'stop_loss', token: TOKEN, share_pct: 100, days: 30, stop_pct: 20, floor_pct: 40 }]);
    assert.equal((await page.evaluate(() => window.signed)).length, 0, 'nothing signed before the user reads it');
    if (process.argv[2]) await page.locator('#sol-orders-card').screenshot({ path: process.argv[2] });
    await page.click('#so-sign');
    await page.waitForFunction(() => /Your order is placed/.test(document.getElementById('so-msg').textContent), null, { timeout: 15000 });
    assert.deepEqual(await page.evaluate(() => window.signed), [[1, 2, 3]], 'the wallet signed the prepared transaction');
    assert.deepEqual(calls.filter(c => c[0] === 'confirm'), [['confirm', 8], ['confirm', 8]], 'confirmed from the chain, waiting until it landed');
    await page.waitForFunction(() => /Stop-loss/.test(document.getElementById('so-list').textContent));
    assert.match(await page.textContent('#so-list'), /1,000 BULL.*0\.8 SOL \(worth 1 when placed\).*0\.594 SOL.*Open/);

    // Cancelling: the wallet signs the cancel; the list says so.
    await page.click('#so-list button:has-text("Cancel")');
    await page.waitForFunction(() => /Cancelled\./.test(document.getElementById('so-msg').textContent), null, { timeout: 15000 });
    assert.deepEqual((await page.evaluate(() => window.signed)).at(-1), [4, 5]);
    assert.match(await page.textContent('#so-list'), /Cancelled/);
    assert.deepEqual(errors, []);
    console.log('ok: the Solana orders card: off with its reason; the worst case before signing; placed from the wallet; cancelled');
  } finally {
    await browser.close();
    app.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

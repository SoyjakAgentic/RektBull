/**
 * Exits with a Solana buy on /trade, in a real Chromium, signed in with a
 * stand-in Solana wallet. The preview is a stand-in (test/buyWithExits.test.js
 * runs the real one on a recorded mainnet route): this checks the page. The
 * option is hidden while orders are off; once on, the boxes send the exits
 * with the preview, and the plan shows them, their worst case and what was
 * left out.
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/buyWithExits.js [screenshot.png]
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', TRADING_ENABLED: 'true' });
const USER = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const PUMP = '3QkTHofooopp7XkBDqjRDC2k1mbkG1d1QTdU8NDRpump';
const SIGNATURE = '5'.repeat(88);

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  const orders = require('../../src/trade/solanaOrders');
  let on = false;
  orders.config = () => (on ? { program: 'P' } : { off: 'Orders on Solana open once RektBull\'s order program has been audited and deployed.' });
  const asked = [];
  require('../../src/trade/proposals').preview = async (_a, input) => {
    asked.push(input.exits || null);
    const exits = input.exits ? {
      orders: [{ kind: 'stop_loss', kind_name: 'Stop-loss', trigger_sol: '0.0072', floor_sol: '0.0058' }],
      covers: 'the 346,108.46 PUMPY this buy is sure to bring (its minimum); anything it brings above that isn\'t covered',
      worst_case: ['Worst case, even if RektBull were hacked: your 346,108.46 PUMPY are sold for 0.0058 SOL after the 1% fee (your floor).'],
      costs: { order_deposits_sol: '0.00218544', fee: 'RektBull\'s 1% of the SOL an exit brings.' },
      note: input.exits.take_profit ? 'Only the stop-loss fitted in the buy\'s transaction: place the take-profit from Orders on Solana once the buy has landed.' : undefined,
    } : undefined;
    return { chain: 'solana', side: 'buy', token: PUMP, base: 'SOL', quoted_at: new Date().toISOString(), plan: { summary: { text: 'Buy $1.00 of PUMPY with SOL on Solana', fee: { amount: '0.0001', asset: 'SOL', pct: 1 }, exits }, checks: [{ ok: true, detail: 'every check (stand-in)' }] }, seen: {} };
  };
  const { rows: [acct] } = await db.query('INSERT INTO accounts (solana_wallet) VALUES ($1) RETURNING id, wallet, solana_wallet', [USER]);
  const token = require('../../src/auth/siwe').issueToken(acct);
  const app = require('../../src/app').createApp().listen(0);
  const base = `http://127.0.0.1:${app.address().port}`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
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
        'solana:signAndSendTransaction': { version: '1.0.0', signAndSendTransaction: async input => { window.signed.push({ chain: input.chain, account: input.account.address, bytes: Array.from(input.transaction) }); return [{ signature: fromB58(sig) }]; } },
      },
    };
    const register = api => api.register(wallet);
    window.addEventListener('wallet-standard:app-ready', e => register(e.detail));
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
  }, [token, USER, SIGNATURE]);

  try {
    // Orders off: no option.
    await page.goto(`${base}/trade?chain=solana&token=${PUMP}&amount=1`);
    await page.click('#wallets button:has-text("Test Solana")');
    await page.locator('#plan li').first().waitFor();
    assert.equal(await page.isVisible('#exits-wrap'), false, 'hidden while orders are off');
    assert.equal(asked.at(-1), null);

    // Orders on: the boxes send the exits, and the plan shows them.
    on = true;
    await page.reload();
    await page.click('#wallets button:has-text("Test Solana")');
    await page.locator('#exits-wrap').waitFor();
    assert.equal(await page.inputValue('#x-stop-pct'), '20', 'from the trading settings');
    await page.check('#x-stop');
    await page.waitForFunction(() => /Exits, in the same transaction/.test(document.getElementById('plan').textContent));
    assert.deepEqual(asked.at(-1), { stop_loss: true, take_profit: false, stop_pct: 20, take_pct: 50 });
    const plan = await page.textContent('#plan');
    assert.match(plan, /stop-loss \(fires at 0\.0072 SOL, never below 0\.0058 SOL\)/);
    assert.match(plan, /Worst case, even if RektBull were hacked/);
    await page.check('#x-take');
    await page.waitForFunction(() => /Only the stop-loss fitted/.test(document.getElementById('plan').textContent));
    if (process.argv[2]) await page.locator('#trade-card').screenshot({ path: process.argv[2] });
    // A sale has no exits option.
    await page.selectOption('#side', 'sell');
    assert.equal(await page.isVisible('#exits-wrap'), false);
    assert.deepEqual(errors, []);
    console.log('ok: exits with a Solana buy: hidden while orders are off; sent with the preview when ticked; shown in the plan, with what was left out');
  } finally {
    await browser.close();
    app.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

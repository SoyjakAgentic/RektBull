/**
 * A Solana buy on /trade in a real Chromium, signed in with a Solana wallet.
 * The wallet is a stand-in registered through the Wallet Standard; it records
 * the transaction it's asked to sign and answers with a signature. Jupiter,
 * the RPC, prices and RektBull's other checks are stand-ins, with Jupiter's
 * answer recorded from mainnet (test/fixtures/jupiter). Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/solanaTrade.js [screenshot.png]
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
const FEE_WALLET = '29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2';
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', TRADING_ENABLED: 'true', SWAP_FEE_WALLET_SOLANA: FEE_WALLET });
const USER = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const PUMP = '3QkTHofooopp7XkBDqjRDC2k1mbkG1d1QTdU8NDRpump';
const SIGNATURE = '5'.repeat(88);

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();

  // The outside world, as stand-ins.
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'jupiter', 'buy-pump.json'), 'utf8'));
  require('../../src/providers/jupiter').setTransport(async p => (p === '/build' ? fixture : { outAmount: '9600000' }));
  const k = require('@solana/kit');
  const tables = Object.fromEntries(Object.entries(fixture.addressesByLookupTableAddress).map(([t, list]) => [t, { owner: 'AddressLookupTab1e1111111111111111111111111', data: [Buffer.concat([Buffer.alloc(56), ...list.map(a => Buffer.from(k.getAddressEncoder().encode(k.address(a))))]).toString('base64'), 'base64'] }]));
  const tokenData = n => { const d = Buffer.alloc(165); d.writeBigUInt64LE(BigInt(n), 64); return [d.toString('base64'), 'base64']; };
  require('../../src/providers/rpc').solanaRpc = async (method, params) => {
    if (method === 'getBalance') return { value: 5_000_000 };
    if (method === 'getMultipleAccounts') return { value: params[0].map(a => (tables[a] ? tables[a] : a === PUMP ? { owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' } : a === USER ? { lamports: 1_000_000_000 } : null)) };
    if (method === 'simulateTransaction') return { value: { err: null, unitsConsumed: 90000, accounts: [{ data: tokenData(349604509500) }] } };
    if (method === 'getRecentPrioritizationFees') return [];
    if (method === 'getSignaturesForAddress') return [{ signature: 'x' }];
    throw new Error(`unexpected ${method}`);
  };
  require('../../src/providers/prices').basePrice = async () => 100;
  require('../../src/services/dueDiligence').quickCheck = async () => ({ verdict: 'low', flags: [] });
  require('../../src/services/launches').forTrade = async () => ({ young: true, risk: 'ok', detail: 'no bundle found (stand-in)', flags: [] });

  const { rows: [acct] } = await db.query('INSERT INTO accounts (solana_wallet) VALUES ($1) RETURNING id, wallet, solana_wallet', [USER]);
  const token = require('../../src/auth/siwe').issueToken(acct);
  const app = require('../../src/app').createApp().listen(0);
  const base = `http://127.0.0.1:${app.address().port}`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
    await page.goto(`${base}/trade?chain=solana&token=${PUMP}&amount=1`);
    await page.click('#wallets button:has-text("Test Solana")');
    await page.locator('#trade-card').waitFor();
    assert.equal(await page.inputValue('#chain'), 'solana');
    assert.equal(await page.inputValue('#base'), 'SOL');
    assert.ok(await page.locator('#limits-card').isHidden(), 'no EVM wallet: no automatic trading card');
    // The preview: every check, and the fee as a SOL transfer.
    await page.locator('#plan li').first().waitFor();
    const plan = await page.textContent('#plan');
    assert.match(plan, /Buy \$1\.00 of 3QkTHofooopp/);
    assert.match(plan, /Pump\.fun, through Jupiter's Router/);
    assert.match(plan, /selling straight back loses 4\.0%/);
    assert.match(plan, /RektBull fee: 0\.0001 SOL \(1%\), a SOL transfer to RektBull in the same transaction as the buy/);
    if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: false });

    // One click: the wallet gets one transaction, for this account's wallet, on Solana mainnet.
    await page.click('#go');
    await page.waitForFunction(() => /Sent:/.test(document.getElementById('trade-msg').textContent));
    const signed = await page.evaluate(() => window.signed);
    assert.equal(signed.length, 1);
    assert.equal(signed[0].chain, 'solana:mainnet');
    assert.equal(signed[0].account, USER);
    const msg = k.getCompiledTransactionMessageDecoder().decode(k.getTransactionDecoder().decode(Uint8Array.from(signed[0].bytes)).messageBytes);
    assert.equal(msg.staticAccounts[0], USER, 'the user pays');
    const { rows: [row] } = await db.query('SELECT status, tx_hash, wallet FROM trade_proposals');
    assert.deepEqual([row.status, row.tx_hash, row.wallet], ['submitted', SIGNATURE, USER]);
    assert.deepEqual(errors, []);
    console.log('ok: a Solana buy previewed, signed in the wallet as one transaction, and recorded');
  } finally {
    await browser.close();
    app.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

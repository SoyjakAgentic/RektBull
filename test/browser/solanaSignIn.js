/**
 * Signing in with a Solana wallet and linking an EVM one, from the header,
 * in a real Chromium. The wallets are stand-ins that register the way real
 * ones do (the Wallet Standard for Solana, EIP-6963 for EVM); their keys stay
 * in this Node process and sign through exposed functions. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/solanaSignIn.js [screenshot.png]
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '' });
const base58 = require('../../src/lib/base58');

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  require('../../src/providers/rpc').solanaRpc = async () => [{ signature: 'x' }]; // no network: a wallet with history

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const solAddress = base58.encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const evm = ethers.Wallet.createRandom();

  const app = require('../../src/app').createApp().listen(0);
  const base = `http://127.0.0.1:${app.address().port}`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('solSign', bytes => [...crypto.sign(null, Buffer.from(bytes), privateKey)]);
  await page.exposeFunction('evmSign', hex => evm.signMessage(ethers.getBytes(hex)));
  await page.addInitScript(([sol, eth]) => {
    // A Solana wallet, as the Wallet Standard defines one.
    const account = { address: sol, publicKey: new Uint8Array(32), chains: ['solana:mainnet'], features: ['solana:signMessage'] };
    const wallet = {
      version: '1.0.0', name: 'Test Solana', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', chains: ['solana:mainnet'], accounts: [],
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
        'solana:signMessage': { version: '1.0.0', signMessage: async ({ message }) => [{ signedMessage: message, signature: new Uint8Array(await window.solSign([...message])) }] },
      },
    };
    const register = api => api.register(wallet);
    window.addEventListener('wallet-standard:app-ready', e => register(e.detail));
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
    // An EVM wallet, announced with EIP-6963.
    const provider = { request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts') return [eth];
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'personal_sign') return window.evmSign(params[0]);
      throw new Error(`unexpected ${method}`);
    } };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'test-evm', name: 'Test EVM', icon: '', rdns: 'test.evm' }, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
  }, [solAddress, evm.address]);

  try {
    await page.goto(base + '/safety');
    // Signed out: the header lists both kinds of wallet.
    await page.click('#hdr-connect');
    const menu = page.locator('#hdr-menu');
    await menu.waitFor();
    assert.deepEqual(await menu.locator('button').allTextContents(), ['Test EVM', 'Test Solana · Solana']);
    // Sign in with the Solana one.
    await menu.locator('button', { hasText: 'Test Solana' }).click();
    await page.waitForFunction(() => /Signed in/.test(document.getElementById('who').textContent));
    assert.equal(await page.textContent('#hdr-connect'), 'Account');
    const token = await page.evaluate(() => sessionStorage.getItem('rb_token'));
    assert.ok(token);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('rb_kind')), 'solana');

    // The account menu: the Solana wallet, no EVM wallet yet, and a button to link one.
    await page.click('#hdr-connect');
    await menu.locator('button', { hasText: 'Link Test EVM' }).waitFor();
    assert.match(await menu.textContent(), /Solana wallet: /);
    assert.match(await menu.textContent(), /EVM wallet: none/);
    await menu.locator('button', { hasText: 'Link Test EVM' }).click();
    await page.waitForFunction(() => /Linked/.test(document.getElementById('toast')?.textContent || ''));
    const { rows: [acct] } = await db.query('SELECT wallet, solana_wallet FROM accounts');
    assert.deepEqual([acct.wallet, acct.solana_wallet], [evm.address.toLowerCase(), solAddress]);

    // Both wallets, each with Unlink; then the screenshot.
    await page.click('#hdr-connect');
    await menu.locator('button', { hasText: 'Sign out' }).waitFor();
    assert.equal(await menu.locator('button.link', { hasText: 'Unlink' }).count(), 2);
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });

    // Signing out forgets the session.
    await menu.locator('button', { hasText: 'Sign out' }).click();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('rb_token')), null);
    assert.doesNotMatch(await page.textContent('#who'), /Signed in/, 'still connected, no longer signed in');
    assert.equal(await page.textContent('#hdr-connect'), 'Sign in');
    assert.deepEqual(errors, []);
    console.log('ok: Solana sign-in, linking an EVM wallet, and signing out, from the header');
  } finally {
    await browser.close();
    app.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

/**
 * Drives /safety in a real browser (Playwright's Chromium) with a stand-in
 * wallet injected as an EIP-6963 provider, against a test server with the
 * token checks and the AI faked. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/safetyPage.js
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
const TOKEN = '0x' + '7a'.repeat(20);
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const MNEMONIC = ethers.Mnemonic.fromPhrase('test test test test test test test test test test test junk');

Object.assign(process.env, {
  DATABASE_URL: DB, JWT_SECRET: 'test', PAYMENT_CHAINS: 'base',
  CRYPTO_DEPOSIT_XPUB: ethers.HDNodeWallet.fromMnemonic(MNEMONIC, "m/44'/60'/0'/0").neuter().extendedKey,
});

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();

  const scan = {
    chain: 'base', token: TOKEN, checked_at: new Date().toISOString(), verdict: 'high',
    flags: [
      { id: 'upgradeable', severity: 'high', title: 'Its code can be replaced (a proxy)', evidence: 'Implementation now: 0xabc', source: 'RPC' },
      { id: 'power_mint', severity: 'medium', title: 'The owner can create new tokens', evidence: 'Functions in the verified source: mint.', source: 'verified ABI' },
    ],
    disagreements: ['The sell tax differs: 1% by 0x, 5% by GoPlus.'],
    not_checked: [{ check: 'goplus', reason: 'GoPlus: timeout' }],
    note: 'Each flag names its source.',
  };
  const dd = require('../../src/services/dueDiligence');
  let failNext = false;
  dd.quickCheck = async () => { if (failNext) { failNext = false; throw new Error('provider down'); } return scan; };
  dd.fullReport = async () => ({
    ...scan,
    report_markdown: '## Verdict\n**High risk**: its code can be replaced.\n\n- The owner can mint\n- <img src=x onerror="window.__xss=1">\n\nThis is an automated check of known patterns, not financial advice or proof of safety.',
    market: { source: 'DexScreener', pairs: 3, liquidity_usd_total: 120000, volume_24h_usd: 45000, first_pair_created_at: new Date(Date.now() - 12 * 86400000).toISOString(), token_name: 'Test Token', token_symbol: 'TEST' },
    written_by: 'test-model',
  });
  require('../../src/ai/claude').available = () => true;
  const credits = require('../../src/payments/credits');

  const { createApp } = require('../../src/app');
  const server = createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;

  const wallet = ethers.Wallet.createRandom();
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('dialog', d => d.accept());
  const sent = [];
  await page.exposeFunction('__sign', async hex => wallet.signMessage(ethers.getBytes(hex)));
  await page.exposeFunction('__sent', tx => { sent.push(tx); return '0x' + String(sent.length).padStart(64, '0'); });
  await page.addInitScript(addr => {
    let chainId = '0x1';
    const provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
        if (method === 'eth_chainId') return chainId;
        if (method === 'wallet_switchEthereumChain') { chainId = params[0].chainId; return null; }
        if (method === 'personal_sign') return window.__sign(params[0]);
        if (method === 'eth_sendTransaction') return window.__sent({ ...params[0], chainId });
        throw new Error('stand-in wallet: ' + method);
      },
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test', name: 'Test Wallet' }, provider } })));
  }, wallet.address);

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const msg = () => page.textContent('#check-msg');

  try {
    await page.goto(url + '/');
    assert.match(page.url(), /\/safety$/, 'the home page is the Safety page for now');
    await page.getByText('· $0.25 · 5 free a day').waitFor();
    await page.getByText('· $3.00').waitFor();
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.card')).borderTopWidth), '1px', 'the stylesheet loaded and parsed');

    // Not signed in: no free checks, and the page says how to get them.
    await page.selectOption('#chain', 'base');
    await page.fill('#token', TOKEN);
    await page.getByRole('button', { name: /Quick check/ }).click();
    await page.locator('#check-msg', { hasText: 'Sign in with your wallet below (free) to get 5 quick checks a day' }).waitFor();
    console.log('✔ signed out: prices shown; a check asks to sign in for the free ones');

    await page.getByRole('button', { name: 'Connect Test Wallet' }).click();
    await page.getByRole('button', { name: 'Sign in with this wallet' }).click();
    await page.getByText('Signed in.').waitFor();
    await page.locator('#free-left', { hasText: '5 of 5' }).waitFor();
    assert.equal(await page.textContent('#balance'), '$0.00');
    console.log('✔ sign in: credits $0.00, 5 of 5 free checks');

    await page.getByRole('button', { name: /Quick check/ }).click();
    await page.getByText('What we found', { exact: true }).waitFor();
    const result = await page.textContent('#result');
    assert.match(result, /High risk/);
    assert.match(result, /Its code can be replaced \(a proxy\).*Source: RPC/s);
    assert.match(result, /The owner can create new tokens.*Source: verified ABI/s);
    assert.match(result, /Where sources disagree.*The sell tax differs/s);
    assert.match(result, /What we couldn't check.*goplus: GoPlus: timeout/s);
    assert.match(result, /Paid with a free check, charged because it completed/);
    await page.locator('#free-left', { hasText: '4 of 5' }).waitFor();
    console.log('✔ quick check: verdict, every flag with its source, disagreements, what couldn\'t be checked; one free use spent');

    failNext = true;
    await page.getByRole('button', { name: /Quick check/ }).click();
    await page.locator('#check-msg', { hasText: 'you weren\'t charged' }).waitFor();
    await page.locator('#free-left', { hasText: '4 of 5' }).waitFor();
    console.log('✔ a failed check: "you weren\'t charged", and the free use is given back');

    await page.getByRole('button', { name: /Full report/ }).click();
    await page.locator('#check-msg', { hasText: 'Token due diligence report costs $3.00; you have $0.00 in credits. Top up below.' }).waitFor();
    console.log('✔ report without credits: says what it costs and what you have');

    // Top up: a deposit address, sent from the wallet as a USDC transfer on Base.
    await page.fill('#t-amount', '10');
    await page.getByRole('button', { name: 'Get a deposit address' }).click();
    await page.getByText('Waiting for your payment').waitFor();
    const depositTo = (await page.textContent('#deposit-address')).trim();
    assert.equal(depositTo, ethers.HDNodeWallet.fromMnemonic(MNEMONIC, "m/44'/60'/0'/0/1").address.toLowerCase());
    await page.getByRole('button', { name: 'Send from my wallet' }).click();
    await page.locator('#topup-msg', { hasText: 'Sent' }).waitFor();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chainId, '0x2105', 'the wallet was switched to Base');
    assert.equal(sent[0].to.toLowerCase(), USDC_BASE);
    const [to, amount] = new ethers.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', sent[0].data);
    assert.equal(to.toLowerCase(), depositTo);
    assert.equal(amount, 10_000_000n, '10 USDC');
    console.log('✔ top up: a deposit address, and the wallet is asked to send exactly 10 USDC to it on Base');

    // Credits arrive (the watcher's job, tested elsewhere), then the report.
    const { rows } = await db.query('SELECT id FROM accounts WHERE wallet = $1', [wallet.address.toLowerCase()]);
    await credits.add(rows[0].id, 1000, 'adjustment', 'test:topup');
    await page.getByRole('button', { name: /Full report/ }).click();
    await page.getByText('Written by test-model from these results only', { exact: false }).waitFor();
    const report = await page.textContent('#result');
    assert.match(report, /Test Token \(TEST\) on Base/);
    assert.match(report, /Liquidity\$120,000/);
    assert.match(report, /Trading for12 days/);
    assert.match(report, /Paid with \$3\.00 from credits/);
    assert.equal(await page.locator('#result .report strong', { hasText: 'High risk' }).count(), 1, 'bold is rendered');
    assert.equal(await page.locator('#result .report img').count(), 0, 'the report text is never HTML');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.match(report, /<img src=x onerror/);
    await page.locator('#balance', { hasText: '$7.00' }).waitFor();
    console.log('✔ report: market facts with source, the written report as text only (no HTML), $3.00 from credits');

    await page.getByRole('button', { name: 'RektBull Pro, 30 days: $9.00' }).click();
    await page.locator('#pass-msg', { hasText: 'Not enough credits: it costs $9.00, you have $7.00' }).waitFor();
    await credits.add(rows[0].id, 200, 'adjustment', 'test:topup2');
    await page.getByRole('button', { name: 'RektBull Pro, 30 days: $9.00' }).click();
    await page.locator('#pass-msg', { hasText: 'is active' }).waitFor();
    await page.locator('#pass', { hasText: 'RektBull Pro, 30 days, until' }).waitFor();
    await page.getByRole('button', { name: /Quick check/ }).click();
    await page.getByText('Paid with your pass').waitFor();
    console.log('✔ passes: refused without enough credits; bought from credits; then checks use the pass');

    await page.setViewportSize({ width: 375, height: 800 });
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 0.5).map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className ? '.' + String(e.className).replace(/ /g, '.') : ''}`));
    assert.deepEqual(wide, [], 'no sideways scroll at phone width');
    await page.screenshot({ path: process.env.SCREENSHOT || '/tmp/rektbull-safety.png', fullPage: true });
    console.log('✔ phone width: no sideways scroll');

    // The sign-in carries over to /trade in the same tab.
    await page.goto(url + '/trade');
    await page.goto(url + '/safety');
    await page.locator('#who', { hasText: 'Signed in' }).waitFor();
    console.log('✔ the sign-in carries over between pages');

    assert.deepEqual(errors.filter(e => !/Failed to load resource/.test(e)), [], 'no page errors');
    console.log('all passed');
  } catch (err) {
    console.error('FAILED:', err.message, errors);
    await page.screenshot({ path: '/tmp/rektbull-safety-failed.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})();

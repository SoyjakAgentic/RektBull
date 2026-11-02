/**
 * Drives /find in a real browser (Playwright's Chromium) with a stand-in
 * wallet, against a test server whose claims service is a stand-in
 * (test/claims.e2e.js runs the real one on a chain). Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/findPage.js
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '' });

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();

  const wallet = ethers.Wallet.createRandom();
  const me = wallet.address.toLowerCase();
  const RWD = '0x' + 'ab'.repeat(20);
  const PTS = '0x' + 'cd'.repeat(20);
  const FEE = '0x' + 'fe'.repeat(20);
  const claims = require('../../src/services/claims');
  const item = (id, symbol, extra) => ({
    id, source: 'merkl', source_label: 'Merkl rewards', chain: 'base', chain_id: 8453, name: `${symbol} rewards from 2 Merkl campaigns`,
    token: { address: id.split(':')[2], symbol, decimals: 6 }, claimable_raw: '1000000000', claimable: '1000.0', pending_raw: '0', pending: null,
    status: 'claimable', reason: null, contract: claims.MERKL.distributor, ends_at: null, details_url: 'https://app.merkl.xyz/users/x',
    checks: ['Merkl\'s proof verified against its root', 'the root is the one onchain in Merkl\'s Distributor', 'what was already claimed read onchain'],
    price_usd: 1, price_source: 'DefiLlama', claimable_usd: 1000, ...extra,
  });
  const checks = [];
  claims.check = async w => {
    checks.push(w);
    return {
      wallet: w, checked_at: new Date().toISOString(),
      items: checks.length > 1 ? [] : [
        item(`merkl:8453:${RWD}`, 'RWD'),
        item(`merkl:8453:${PTS}`, 'PTS', { claimable: '500.0', price_usd: null, price_source: null, claimable_usd: null }),
        item('merkl:1:0x' + '11'.repeat(20), 'OLD', { chain: 'ethereum', chain_id: 1, status: 'updating', reason: 'Merkl is publishing an update. Try again in a few hours.', checks: [] }),
      ],
      summary: { claimable: 2, claimable_usd: 1000, not_priced: 1, chains: ['base'] },
      sources: [{ id: 'merkl', name: 'Merkl rewards', read: true }, { id: 'programs', name: 'Airdrops RektBull added', read: true }],
      not_checked: [], fee: { bps: 500, rate: '5%', safety_pro: false, standard_rate: '5%', pro_rate: '3%' },
      note: 'Checking is free.',
    };
  };
  let asked = null;
  claims.prepare = async input => {
    asked = input;
    return {
      claim_id: '00000000-0000-4000-8000-000000000001', wallet: input.wallet, chain: 'base', chain_id: '0x2105',
      calls: [
        { to: claims.MERKL.distributor, value: '0x0', data: '0x2e7ba6ef', label: 'Claim RWD, PTS from Merkl' },
        { to: RWD, value: '0x0', data: '0xa9059cbb', label: 'Claim fee: 50.0 RWD (5%) to RektBull' },
      ],
      atomic: true,
      summary: [
        { id: `merkl:8453:${RWD}`, token: { address: RWD, symbol: 'RWD', decimals: 6 }, receive: '1000.0', receive_usd: 1000, fee: '50.0', fee_raw: '50000000', fee_usd: 50, fee_reason: null, keep: '950.0' },
        { id: `merkl:8453:${PTS}`, token: { address: PTS, symbol: 'PTS', decimals: 6 }, receive: '500.0', receive_usd: null, fee: '0.0', fee_raw: '0', fee_usd: null, fee_reason: 'the token can\'t be transferred yet, so this claim is free', keep: '500.0' },
      ],
      fee: { bps: 500, rate: '5%', safety_pro: false, to: FEE }, warnings: [],
      note: 'Your wallet shows 2 calls.',
    };
  };
  const confirmed = [];
  claims.confirm = async (id, hashes) => { confirmed.push(hashes); return { status: 'confirmed', received: {}, fee_paid: {} }; };

  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const sent = [];
  await page.exposeFunction('__sent', tx => { sent.push(tx); return '0x' + String(sent.length).padStart(64, '0'); });
  await page.addInitScript(addr => {
    let chainId = '0x1';
    window.__batching = true;
    const provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
        if (method === 'eth_chainId') return chainId;
        if (method === 'wallet_switchEthereumChain') { chainId = params[0].chainId; return null; }
        if (method === 'eth_sendTransaction') return window.__sent({ ...params[0], chainId });
        if (method === 'eth_getTransactionReceipt') return { status: '0x1', transactionHash: params[0] };
        if (method === 'wallet_sendCalls') {
          if (!window.__batching) throw Object.assign(new Error('Method not supported'), { code: 4200 });
          window.__bundle = params[0];
          return { id: 'bundle-1' };
        }
        if (method === 'wallet_getCallsStatus') return { status: 200, receipts: [{ transactionHash: '0x' + 'b1'.repeat(32) }] };
        throw new Error('stand-in wallet: ' + method);
      },
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test', name: 'Test Wallet' }, provider } })));
  }, wallet.address);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  try {
    await page.goto(url + '/find');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.card')).borderTopWidth), '1px', 'the stylesheet loaded');
    await page.locator('#fee-what', { hasText: '5% of what you receive (3% with Safety Pro)' }).waitFor();
    await page.locator('#programs', { hasText: 'None yet' }).waitFor();

    // The free check, without signing in.
    await page.getByRole('button', { name: 'Connect Test Wallet' }).click();
    await page.locator('#connect-msg', { hasText: 'Connected' }).waitFor();
    await page.fill('#f-wallet', wallet.address);
    await page.getByRole('button', { name: 'Check for free' }).click();
    await page.locator('#f-result', { hasText: 'Claimable now' }).waitFor();
    const text = await page.textContent('#f-result');
    assert.match(text, /1,000 RWD \(about \$1,000\.00, price from DefiLlama\)/);
    assert.match(text, /500 PTS \(no market price yet\)/);
    assert.match(text, /Not yet: being updated/);
    assert.match(text, /Merkl is publishing an update/);
    assert.match(text, /Claim on their site instead \(free\)/);
    assert.equal(await page.getByRole('button', { name: 'Prepare claim on Ethereum' }).isDisabled(), true, 'nothing claimable there');
    console.log('✔ the free check lists what can be claimed, what can\'t yet and why, with sources');

    // Preparing: the fee is spelled out before anything is signed.
    await page.getByRole('button', { name: 'Prepare claim on Base' }).click();
    await page.locator('#claim-card', { hasText: 'You claim 1,000 RWD' }).waitFor();
    assert.deepEqual(asked, { wallet: me, chain: 'base', ids: [`merkl:8453:${RWD}`, `merkl:8453:${PTS}`] });
    const claim = await page.textContent('#claim-card');
    assert.match(claim, /950 stay in your wallet, 50 RWD go to RektBull's fee wallet \(5%, about \$50\.00\)/);
    assert.match(claim, /No fee: the token can't be transferred yet/);
    assert.match(claim, new RegExp(`Fee wallet: ${FEE}`));
    console.log('✔ before signing: what arrives, what stays, the fee and where it goes');

    // Sent as one bundle, all or nothing.
    await page.getByRole('button', { name: 'Claim with my wallet' }).click();
    await page.locator('#c-msg', { hasText: 'Claimed.' }).waitFor();
    const bundle = await page.evaluate(() => window.__bundle);
    assert.equal(bundle.atomicRequired, true, 'the fee is only paid if the claim works');
    assert.equal(bundle.chainId, '0x2105');
    assert.deepEqual(bundle.calls.map(c => c.to), [claims.MERKL.distributor, RWD]);
    assert.deepEqual(confirmed[0], ['0x' + 'b1'.repeat(32)]);
    console.log('✔ a wallet that bundles sends the claim and the fee together (atomic), then RektBull reads the receipt');

    // A wallet that can't bundle: one at a time, the claim first.
    await page.locator('#f-result', { hasText: 'Nothing to claim' }).waitFor();
    checks.length = 0;
    await page.evaluate(() => { window.__batching = false; });
    await page.getByRole('button', { name: 'Check for free' }).click();
    await page.getByRole('button', { name: 'Prepare claim on Base' }).click();
    await page.getByRole('button', { name: 'Claim with my wallet' }).click();
    await page.locator('#c-msg', { hasText: 'Claimed.' }).waitFor();
    assert.deepEqual(sent.map(s => s.to), [claims.MERKL.distributor, RWD], 'claim first, then the fee');
    assert.equal(confirmed[1].length, 2);
    console.log('✔ a wallet that can\'t bundle sends the claim first, then the fee');

    // Only the wallet it's owed to can claim.
    checks.length = 0;
    await page.fill('#f-wallet', '0x' + '99'.repeat(20));
    await page.getByRole('button', { name: 'Check for free' }).click();
    await page.getByRole('button', { name: 'Prepare claim on Base' }).click();
    await page.getByRole('button', { name: 'Claim with my wallet' }).click();
    await page.locator('#c-msg', { hasText: 'only it can claim what\'s owed to it' }).waitFor();
    console.log('✔ claiming for another wallet is stopped before the wallet is asked');

    await page.setViewportSize({ width: 375, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'no sideways scrolling at phone width');
    console.log('✔ fits a phone screen');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

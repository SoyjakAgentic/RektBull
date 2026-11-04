/**
 * Drives /trade in a real browser (Playwright's Chromium) with a stand-in
 * wallet injected as an EIP-6963 provider, against a test server with 0x
 * and the token check faked. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/tradePage.js
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
const AH = '0x0000000000001ff3684f28c67538d4d072c22734';
const TOKEN = '0x' + '7a'.repeat(20);

Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', TRADING_ENABLED: 'true', SWAP_FEE_WALLET_EVM: '0x' + 'fe'.repeat(20), ZEROEX_API_KEY: 'test', SESSION_KEY_ADDRESS: '0x' + '5e'.repeat(20) });

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  require('../../src/services/dueDiligence').quickCheck = async () => ({ verdict: 'high', flags: [{ id: 'upgradeable', severity: 'high', title: 'Its code can be replaced (a proxy)', evidence: 'Implementation: 0xabc' }] });
  require('../../src/trade/zeroex').setTransport(async (path, params) => (params.sellToken.toLowerCase() === TOKEN
    ? { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: '97000000', minBuyAmount: '96000000' }
    : { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: '1000000', minBuyAmount: '990000', issues: { allowance: { spender: AH } }, transaction: { to: AH, data: '0xdeadbeef', value: '0', gas: '200000' } }));

  const { createApp } = require('../../src/app');
  const server = createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;

  const wallet = ethers.Wallet.createRandom();
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const sent = [];
  // The stand-in wallet: signs with a test key, sends nothing anywhere.
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
        if (method === 'eth_signTypedData_v4') return '0x' + '00'.repeat(65);
        if (method === 'wallet_sendCalls') throw Object.assign(new Error('Method not supported'), { code: 4200 });
        if (method === 'eth_sendTransaction') return window.__sent(params[0]);
        if (method === 'eth_getTransactionReceipt') return { status: '0x1' };
        throw new Error('stand-in wallet: ' + method);
      },
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test', name: 'Test Wallet' }, provider } })));
  }, wallet.address);

  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  try {
    await page.goto(url + '/trade');
    await page.getByRole('button', { name: 'Connect Test Wallet' }).click();
    await page.getByRole('button', { name: 'Sign in with this wallet' }).click();
    await page.getByText('Signed in.').waitFor();
    console.log('✔ connect and sign in with the wallet');

    assert.equal(await page.isVisible('#fraction-wrap'), false, 'the sell share is hidden on a buy');
    await page.fill('#token', TOKEN);
    await page.fill('#amount', '100');
    await page.getByRole('button', { name: 'Check this trade' }).click();
    await page.getByText('high risk').first().waitFor();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('Tick the box').waitFor();
    await page.check('#ack');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('RektBull fee:').waitFor();
    assert.match(await page.textContent('#plan'), /Buy \$100\.00 of 0x7a7a/);
    console.log('✔ check a trade: high risks must be acknowledged; the plan shows the checks and the 1% fee');

    await page.getByRole('button', { name: 'Approve and sign in my wallet' }).click();
    await page.getByText('RektBull will confirm it onchain').waitFor();
    assert.equal(sent.length, 2, 'approve, then swap');
    assert.equal(sent[0].to.toLowerCase(), '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    assert.equal(sent[1].to.toLowerCase(), AH);
    assert.equal(sent[1].data, '0xdeadbeef');
    await page.getByText('submitted').first().waitFor();
    console.log('✔ approve: the wallet is asked for the approval (USDC to AllowanceHolder) and the swap; the trade shows as submitted');

    await page.fill('#l-day', '25000');
    assert.equal(await page.isVisible('#confirm-wrap'), true, 'above the defaults asks for confirmation');
    assert.match(await page.textContent('#worst'), /At most \$25,000 a day/);
    await page.getByRole('button', { name: 'Save limits from my wallet' }).click();
    await page.getByText('Type 25000 in the box').waitFor();
    assert.equal(sent.length, 2, 'nothing sent without the confirmation');
    await page.fill('#l-confirm', '25000');
    await page.getByRole('button', { name: 'Save limits from my wallet' }).click();
    await page.getByText('Limits saved onchain').waitFor();
    assert.equal(sent.length, 3);
    const call = new ethers.Interface(['function setLimits(uint128,uint128,uint32,uint64)']).decodeFunctionData('setLimits', sent[2].data);
    assert.equal(call[0], 500n * 10n ** 8n);
    assert.equal(call[1], 25000n * 10n ** 8n);
    console.log('✔ limits: $25,000/day needs the typed confirmation, then the wallet is asked to sign setLimits on the router');

    // Automatic trading: test tokens, and the steps that need limits first.
    await page.getByRole('button', { name: 'Get 1,000 test tUSDC' }).click();
    await page.getByText('1,000 more test tUSDC').waitFor();
    assert.equal(sent.length, 4);
    assert.equal(sent[3].to.toLowerCase(), require('../../src/trade/networks').network(84532).tokens.tUSDC.address, 'mint on the test tUSDC');
    await page.getByRole('button', { name: 'Let the router trade my tokens' }).click();
    await page.getByText('Save your limits first').waitFor();
    await page.getByRole('button', { name: 'Sign the permission' }).click();
    await page.getByText('Set your trading limits on the router first').waitFor();
    assert.equal(sent.length, 4, 'nothing approved or signed without limits onchain');
    assert.match(await page.textContent('#smart-status'), /plain account/);
    console.log('✔ automatic trading: test tokens; approvals and the permission wait for limits onchain');

    // Coinbase Smart Wallet: the setup goes out from the wallet; linking checks it onchain.
    await page.selectOption('#w-type', 'coinbase');
    assert.equal(await page.isVisible('#grant'), false, 'MetaMask-only steps are hidden');
    await page.fill('#l-day', '10000');
    await page.getByRole('button', { name: 'Set up from my wallet' }).click();
    await page.getByText('Setup sent').waitFor();
    const cbCalls = sent.slice(4);
    assert.equal(cbCalls.length, 4, 'limits, operator, and a spend permission per test token');
    const net = require('../../src/trade/networks').network(84532);
    assert.equal(cbCalls[0].to.toLowerCase(), net.router);
    assert.equal(cbCalls[2].to.toLowerCase(), net.spendPermissionManager);
    await page.getByRole('button', { name: 'Link my wallet' }).click();
    await page.locator('#limits-msg', { hasText: /not approved with Coinbase|name RektBull/ }).waitFor(); // the stand-in wallet sent nothing for real
    console.log('✔ Coinbase: one setup batch from the wallet (limits, operator, spend permissions to the router); linking is checked onchain');

    // Safe: setup transactions to submit from the Safe; linking checks ownership onchain.
    await page.selectOption('#w-type', 'safe');
    await page.fill('#safe-addr', '0x' + '42'.repeat(20));
    await page.getByRole('button', { name: "Get my Safe's setup transactions" }).click();
    await page.getByText('Enable the RektBull Safe Module').waitFor();
    assert.equal(await page.locator('#safe-calls li').count(), 5, 'enable module, two approvals, limits, session');
    await page.getByRole('button', { name: 'Link my Safe' }).click();
    await page.locator('#limits-msg', { hasText: /not a Safe on this network|not an owner/ }).waitFor();
    console.log('✔ Safe: the setup transactions are listed; linking someone else\'s Safe is refused');

    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'no sideways scroll at phone width');
    await page.screenshot({ path: process.env.SCREENSHOT || '/tmp/rektbull-trade.png', fullPage: true });
    console.log('✔ phone width: no sideways scroll');

    assert.deepEqual(errors.filter(e => !/Failed to load resource/.test(e)), [], 'no page errors');
    console.log('all passed');
  } catch (err) {
    console.error('FAILED:', err.message, errors);
    await page.screenshot({ path: '/tmp/rektbull-trade-failed.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})();

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
    ? (params.buyToken.toLowerCase() === '0x55d398326f99059ff775485246999027b3197955' // BNB Chain's USDT has 18 decimals
      ? { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: String(97n * 10n ** 18n), minBuyAmount: String(96n * 10n ** 18n) }
      : { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: '97000000', minBuyAmount: '96000000' })
    : { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: '1000000', minBuyAmount: '990000', issues: { allowance: { spender: AH } }, transaction: { to: AH, data: '0xdeadbeef', value: '0', gas: '200000' } }));

  // No launchpad and no young-token check here (both would read live chains).
  require('../../src/services/launchpads').identify = async () => ({ launchpad: null });
  require('../../src/services/launches').forTrade = async () => ({ young: false, risk: 'ok', detail: 'its first pool opened 30 days ago (test)' });
  // The chain's fees, as a stand-in: Fast offers 1 gwei on top of a 5 gwei base fee.
  require('../../src/trade/fees').suggest = async (chain, speed) => (speed === 'standard' ? { speed, none: 'Your wallet chooses the fee.' } : chain === 'arbitrum'
    ? { speed, none: 'Arbitrum orders transactions as they arrive.' }
    : { speed, max_priority_fee_per_gas: speed === 'fast' ? '0x3b9aca00' : '0x77359400', max_fee_per_gas: '0x2cb417800', base_fee_per_gas: '0x12a05f200', source: 'stand-in' });
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
    const known = new Set(['0x1', '0x2105', '0xa4b1', '0x14a34']); // BNB Chain isn't, until it's added
    window.__added = [];
    const provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
        if (method === 'eth_chainId') return chainId;
        if (method === 'wallet_switchEthereumChain') {
          if (!known.has(params[0].chainId)) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
          chainId = params[0].chainId; return null;
        }
        if (method === 'wallet_addEthereumChain') { window.__added.push(params[0]); known.add(params[0].chainId); chainId = params[0].chainId; return null; }
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
    assert.deepEqual(await page.$$eval('#presets button', b => b.map(x => x.textContent)), ['Buy $25', 'Buy $50', 'Buy $100']);
    const sentNow = async n => { for (let i = 0; i < 100 && sent.length < n; i++) await page.waitForTimeout(100); assert.equal(sent.length, n); };
    await page.fill('#amount', '100');
    await page.fill('#token', TOKEN);
    // The checks run as soon as the token is in; high risks must be read and confirmed before anything can be bought.
    await page.getByText('high risk').first().waitFor();
    assert.equal(await page.isDisabled('#go'), true, 'nothing to click until the risks are confirmed');
    await page.check('#ack');
    await page.getByText('RektBull fee:').waitFor();
    assert.match(await page.textContent('#plan'), /Buy \$100\.00 of 0x7a7a/);
    assert.match(await page.textContent('#plan-age'), /Checked \d+ s ago/);
    assert.equal(await page.textContent('#go'), 'Buy $100');
    assert.equal(sent.length, 0, 'nothing is sent before the click');
    console.log('✔ preview: the checks run as soon as the token is in; high risks must be confirmed; the plan shows the checks and the 1% fee');

    await page.click('#go');
    await sentNow(2);
    await page.locator('#trade-msg', { hasText: 'RektBull will confirm it onchain' }).waitFor();
    assert.equal(sent[0].to.toLowerCase(), '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    assert.equal(sent[1].to.toLowerCase(), AH);
    assert.equal(sent[1].data, '0xdeadbeef');
    await page.getByText('submitted').first().waitFor();
    const { rows: [first] } = await db.query('SELECT plan FROM trade_proposals ORDER BY created_at DESC LIMIT 1');
    assert.equal(first.plan.one_click, true);
    assert.equal(first.plan.timing.previewed, true);
    assert.ok(first.plan.timing.click_to_prompt_ms >= 0 && first.plan.timing.click_to_prompt_ms < 10000, JSON.stringify(first.plan.timing));
    console.log(`✔ one click: straight to the wallet (approval of USDC to AllowanceHolder, then the swap) in ${first.plan.timing.click_to_prompt_ms} ms; the trade shows as submitted`);

    // BNB Chain: its own base assets; a wallet that doesn't have the chain is asked to add it.
    await page.selectOption('#chain', 'bsc');
    assert.deepEqual(await page.$$eval('#base option', o => o.map(x => x.textContent)), ['USDT', 'USDC', 'BNB', 'WBNB']);
    assert.equal(await page.inputValue('#base'), 'USDC', 'the asset picked on Base is kept where BNB Chain has it too');
    await page.selectOption('#base', 'USDT');
    await page.locator('#plan', { hasText: /Buy \$100\.00 of 0x7a7a.* with USDT on BNB Chain/ }).waitFor();
    await page.click('#go');
    await sentNow(4);
    const added = await page.evaluate(() => window.__added);
    assert.deepEqual(added.map(a => [a.chainId, a.chainName, a.nativeCurrency.symbol]), [['0x38', 'BNB Smart Chain', 'BNB']]);
    assert.equal(sent[2].to.toLowerCase(), '0x55d398326f99059ff775485246999027b3197955', 'USDT on BNB Chain approved');
    assert.equal(sent[3].to.toLowerCase(), AH);
    await page.locator('#trade-msg', { hasText: 'RektBull will confirm it onchain' }).waitFor();
    console.log('✔ BNB Chain: USDT, USDC, BNB and WBNB; a wallet without the chain is asked to add it; approve then swap');

    // A preset is one click too: the amount is set and the trade goes to the wallet on the preview just shown.
    await page.locator('#presets button', { hasText: 'Buy $50' }).click();
    await sentNow(6);
    await page.locator('#trade-msg', { hasText: 'RektBull will confirm it onchain' }).waitFor();
    assert.equal(await page.inputValue('#amount'), '50');
    const { rows: [preset] } = await db.query('SELECT amount_usd, plan FROM trade_proposals ORDER BY created_at DESC LIMIT 1');
    assert.equal(Number(preset.amount_usd), 50);
    assert.equal(preset.plan.timing.previewed, true, 'traded on the preview shown, by its price');
    console.log('✔ presets: "Buy $50" sends a checked $50 buy to the wallet in one click');

    // The buttons are the user's own.
    await page.fill('#s-buys', '10, 20');
    await page.fill('#s-sells', '50, 100');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.locator('#settings-msg', { hasText: 'Saved.' }).waitFor();
    await page.locator('#presets button', { hasText: 'Buy $10' }).waitFor();
    assert.deepEqual(await page.$$eval('#presets button', b => b.map(x => x.textContent)), ['Buy $10', 'Buy $20']);
    await page.selectOption('#side', 'sell');
    assert.deepEqual(await page.$$eval('#presets button', b => b.map(x => x.textContent)), ['Sell 50%', 'Sell 100%']);
    await page.selectOption('#side', 'buy');
    console.log('✔ settings: the one-click buttons are the user\'s own');

    // Protected sending: Base needs nothing; Ethereum adds Flashbots Protect in one click; BNB Chain offers two.
    await page.selectOption('#side', 'buy');
    await page.selectOption('#chain', 'base');
    await page.locator('#p-note', { hasText: 'no public mempool' }).waitFor();
    assert.equal(await page.locator('#p-networks button').count(), 0);
    await page.selectOption('#chain', 'ethereum');
    await page.getByRole('button', { name: 'Add Flashbots Protect to my wallet' }).waitFor();
    assert.match(await page.textContent('#p-fees'), /Fast: 1\.00 gwei priority fee/);
    await page.getByRole('button', { name: 'Add Flashbots Protect to my wallet' }).click();
    await page.locator('#p-msg', { hasText: 'Added.' }).waitFor();
    const fb = (await page.evaluate(() => window.__added)).at(-1);
    assert.deepEqual(fb, { chainId: '0x1', chainName: 'Flashbots Protect', rpcUrls: ['https://rpc.flashbots.net/fast'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: ['https://etherscan.io'] });
    assert.match(await page.textContent('#p-networks'), /Don't switch your wallet's network before a trade confirms/);
    await page.selectOption('#chain', 'bsc');
    await page.getByRole('button', { name: 'Add PancakeSwap MEV Guard to my wallet' }).waitFor();
    assert.equal(await page.locator('#p-networks button').count(), 2, 'PancakeSwap MEV Guard and 48 Club');
    console.log('✔ protected sending: nothing to add on Base; Flashbots Protect added in one click on Ethereum, with its caveats; two choices on BNB Chain');

    // Fast: the wallet is asked to send each step with the fee read from the chain.
    await page.selectOption('#s-speed', 'fast');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.locator('#settings-msg', { hasText: 'Saved.' }).waitFor();
    await page.selectOption('#chain', 'base');
    await page.locator('#p-chain', { hasText: 'Base' }).waitFor();
    await page.fill('#amount', '20');
    await page.locator('#ack').waitFor(); // the stand-in token check's high risk, confirmed again after the side switch above
    await page.check('#ack');
    await page.locator('#plan', { hasText: 'Buy $20.00' }).waitFor();
    await page.click('#go');
    await sentNow(8);
    assert.deepEqual(sent.slice(6).map(t => [t.maxPriorityFeePerGas, t.maxFeePerGas]), [['0x3b9aca00', '0x2cb417800'], ['0x3b9aca00', '0x2cb417800']], 'both steps carry the fee');
    await page.locator('#trade-msg', { hasText: 'RektBull will confirm it onchain' }).waitFor();
    console.log('✔ speed: with Fast saved, both steps of a trade go to the wallet with the fee read from the chain');

    sent.splice(2, 6); // the rest of this test counts from the first trade

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

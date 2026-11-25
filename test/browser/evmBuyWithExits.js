/**
 * Exits with a buy on Base on /trade, in a real Chromium, with a stand-in EIP-6963 wallet that really signs (a test
 * key) and sends nothing anywhere, against the real server: 0x and the token check faked, the order service on the
 * stand-in chain of test/helpers/memeChain.js. The boxes send the exits with the preview; the plan shows them; a
 * click sends the buy with the router's approval after the swap, then the wallet signs each exit, and they wait for
 * the buy.
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/evmBuyWithExits.js [screenshot.png]
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
const { standIn, ROUTER_BASE, ROUTER_BSC, AH, BULL } = require('../helpers/memeChain');
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
Object.assign(process.env, {
  DATABASE_URL: DB, JWT_SECRET: 'test', TRADING_ENABLED: 'true', SWAP_FEE_WALLET_EVM: '0x' + 'fe'.repeat(20), ZEROEX_API_KEY: 'test',
  MEME_ORDERS_ENABLED: 'true', MEME_ROUTERS: JSON.stringify({ base: ROUTER_BASE, bsc: ROUTER_BSC }), MEME_ORDERS_EXECUTOR: '0x' + 'e'.repeat(40),
});

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  const orders = require('../../src/trade/memeOrders');
  const chain = standIn();
  chain.hold(BULL, '0x' + '0'.repeat(40), 0n);
  orders._setProvider(name => chain.provider(orders.CHAINS[name].chainId));
  require('../../src/services/dueDiligence').quickCheck = async () => ({ verdict: 'low', flags: [], disagreements: [] });
  require('../../src/services/launchpads').identify = async () => ({ launchpad: null });
  require('../../src/services/launches').forTrade = async () => ({ young: false, risk: 'ok', detail: 'its first pool opened 30 days ago (test)' });
  require('../../src/providers/dexscreener').pairs = async (c, tokens) => Object.fromEntries(tokens.map(t => [t, { price_usd: 0.1, symbol: 'BULL' }]));
  require('../../src/providers/prices').usdPrice = async () => 3000;
  require('../../src/trade/fees').suggest = async speed => ({ speed, none: 'Your wallet chooses the fee.' });
  require('../../src/trade/zeroex').setTransport(async (path, params) => (params.buyToken.toLowerCase() === BULL
    ? { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: String(BigInt(params.sellAmount) * 10n ** 13n), minBuyAmount: String(BigInt(params.sellAmount) * 99n * 10n ** 11n), issues: { allowance: { spender: AH } }, transaction: { to: AH, data: '0xbeef', value: '0' } }
    : { liquidityAvailable: true, sellAmount: params.sellAmount, buyAmount: String(BigInt(params.sellAmount) * 97n / 10n ** 15n), minBuyAmount: '1' }));
  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;

  const wallet = ethers.Wallet.createRandom();
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const sent = [];
  const signedTyped = [];
  await page.exposeFunction('__sign', async hex => wallet.signMessage(ethers.getBytes(hex)));
  await page.exposeFunction('__signTyped', async json => {
    const td = JSON.parse(json);
    const { EIP712Domain, ...types } = td.types;
    signedTyped.push({ sent_before: sent.length, td });
    return wallet.signTypedData(td.domain, types, td.message);
  });
  await page.exposeFunction('__sent', t => { sent.push(t); return '0x' + String(sent.length).padStart(64, '0'); });
  await page.addInitScript(addr => {
    let chainId = '0x2105';
    const provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
        if (method === 'eth_chainId') return chainId;
        if (method === 'wallet_switchEthereumChain') { chainId = params[0].chainId; return null; }
        if (method === 'personal_sign') return window.__sign(params[0]);
        if (method === 'eth_signTypedData_v4') return window.__signTyped(params[1]);
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

  try {
    await page.goto(`${url}/trade?chain=base`);
    await page.getByRole('button', { name: 'Connect Test Wallet' }).click();
    await page.getByRole('button', { name: 'Sign in with this wallet' }).click();
    await page.getByText('Signed in.').waitFor();
    await page.selectOption('#chain', 'base');
    await page.fill('#amount', '100');
    await page.fill('#token', BULL);
    await page.getByText('RektBull fee:').waitFor();
    assert.equal(await page.isVisible('#exits-wrap'), true, 'offered on Base once the Meme Router is set up');
    assert.match(await page.textContent('#exits-label'), /signed right after it/);
    await page.check('#x-stop');
    await page.check('#x-take');
    await page.waitForFunction(() => /Exits: stop-loss/.test(document.getElementById('plan').textContent));
    const plan = await page.textContent('#plan');
    assert.match(plan, /stop-loss \(fires at 0\.0264 ETH, never below 0\.0212355 ETH\); take-profit \(fires at 0\.0495 ETH, never below 0\.04753485 ETH\)/);
    assert.match(plan, /For the 990 BULL this buy is sure to bring/);
    assert.match(plan, /Worst case, even if RektBull were hacked/);
    assert.match(plan, /No deposit: an order is only a signature/);
    if (process.argv[2]) await page.locator('#trade-card').screenshot({ path: process.argv[2] });
    console.log('✔ the exits are offered on Base, sent with the preview, and shown in the plan with their worst case');

    await page.click('#go');
    await page.locator('#trade-msg', { hasText: 'they open when the buy lands' }).waitFor({ timeout: 20000 });
    assert.deepEqual(sent.map(t => t.to.toLowerCase()), [USDC, AH, BULL], 'the approval for the swap, the swap, then the router\'s approval for the exits');
    assert.deepEqual(require('../../src/trade/memeOrderTx').ERC20.decodeFunctionData('approve', sent[2].data).map(String), [ethers.getAddress(ROUTER_BASE), (1980n * 10n ** 18n).toString()]);
    assert.equal(signedTyped.length, 2);
    assert.ok(signedTyped.every(s => s.sent_before === 3), 'the exits are signed after the buy is sent, so it isn\'t held up');
    const { rows } = await db.query(`SELECT kind, state, signature IS NOT NULL AS signed, trade_id IS NOT NULL AS with_trade FROM meme_orders ORDER BY id`);
    assert.deepEqual(rows, [{ kind: 'stop_loss', state: 'prepared', signed: true, with_trade: true }, { kind: 'take_profit', state: 'prepared', signed: true, with_trade: true }]);
    assert.deepEqual(errors, []);
    console.log('✔ a click sends the buy with the router\'s approval after the swap, then the wallet signs both exits; they wait for the buy');
    console.log('ok: exits with a buy on Base');
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

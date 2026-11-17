/**
 * The Perps page (Hyperliquid) in a real Chromium: sign in, approve a
 * trading key made in the browser, place an order signed by that key, then
 * turn automatic trading on with limits and stop it. The wallet is a
 * stand-in that signs with a test key; Hyperliquid is a stand-in that
 * records what it's sent, with market data recorded from its info API
 * (test/fixtures/hyperliquid). Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/perps.js [screenshot.png]
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
const agentKey = ethers.Wallet.createRandom();
const BUILDER = '0x' + 'b1'.repeat(20);
Object.assign(process.env, {
  DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', HL_ENABLED: 'true', HL_NETWORK: 'testnet',
  HL_AUTO_ENABLED: 'true', HL_AGENT_ADDRESS: agentKey.address, HL_BUILDER_ADDRESS: BUILDER, HL_BUILDER_FEE_TENTHS_BPS: '10',
});
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'hyperliquid', `${name}.json`), 'utf8'));

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  require('../../src/providers/llama').protocols = async () => [];
  const H = require('../../public/hl-core.js');

  // The stand-in Hyperliquid: approvals are remembered, so the page sees what it approved.
  const sent = [];
  const agents = [];
  let feeApproved = 0;
  const hl = require('../../src/providers/hyperliquid');
  hl.setTransport(async (p, body) => {
    if (p === '/exchange') {
      sent.push(body);
      const a = body.action;
      if (a.type === 'approveAgent') {
        const [name, , until] = a.agentName.split(' ');
        const i = agents.findIndex(x => x.name === name);
        if (i >= 0) agents.splice(i, 1);
        agents.push({ name, address: a.agentAddress, validUntil: Number(until) });
      }
      if (a.type === 'approveBuilderFee') feeApproved = Math.round(Number(a.maxFeeRate.replace('%', '')) * 1000);
      if (a.type === 'order') return { status: 'ok', response: { type: 'order', data: { statuses: a.orders.map(() => ({ filled: { totalSz: '0.00076', avgPx: '65400', oid: 7 } })) } } };
      return { status: 'ok', response: { type: 'default' } };
    }
    return {
      metaAndAssetCtxs: fixture('metaAndAssetCtxs'), clearinghouseState: fixture('clearinghouseState'), frontendOpenOrders: fixture('frontendOpenOrders'),
      extraAgents: agents, maxBuilderFee: feeApproved,
    }[body.type];
  });

  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const wallet = ethers.Wallet.createRandom();
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.exposeFunction('__sign', async hex => wallet.signMessage(ethers.getBytes(hex)));
  await page.exposeFunction('__signTyped', async json => {
    const t = JSON.parse(json);
    const { EIP712Domain, ...types } = t.types;
    return wallet.signTypedData(t.domain, types, t.message);
  });
  await page.addInitScript(addr => {
    const provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
        if (method === 'eth_chainId') return '0xa4b1';
        if (method === 'personal_sign') return window.__sign(params[0]);
        if (method === 'eth_signTypedData_v4') return window.__signTyped(params[1]);
        throw new Error('stand-in wallet: ' + method);
      },
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test', name: 'Test Wallet' }, provider } })));
    window.confirm = () => true;
  }, wallet.address);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  try {
    await page.goto(url + '/perps');
    await page.locator('#markets tr td button').first().waitFor();
    assert.match(await page.textContent('#markets-msg'), /Hyperliquid's info API/);
    await page.getByRole('button', { name: 'Connect Test Wallet' }).click();
    await page.getByRole('button', { name: 'Sign in with this wallet' }).click();
    await page.getByText('Signed in.').waitFor();
    console.log('✔ markets shown; signed in');

    // The trading key: made in the browser, approved by the wallet, kept only in this browser.
    await page.locator('#setup-card').waitFor();
    await page.click('#agent-approve');
    await page.locator('#setup-msg', { hasText: 'Approved' }).waitFor();
    const approve = sent.find(s => s.action.type === 'approveAgent');
    assert.equal(H.recoverUser(approve.action, approve.signature), wallet.address.toLowerCase(), 'the wallet signed the approval');
    const stored = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('rb_hl_agent:')));
    assert.equal(stored.length, 1);
    console.log('✔ trading key approved and kept in the browser');

    // The fee, approved once.
    await page.click('#fee-approve');
    await page.waitForFunction(() => /^Approved:/.test(document.getElementById('fee-status').textContent));
    assert.equal(sent.at(-1).action.type, 'approveBuilderFee');
    console.log('✔ fee approved');

    // A market order: signed by the browser's key, with RektBull's builder code.
    await page.locator('#order-card').waitFor();
    await page.fill('#o-usd', '50');
    await page.locator('#o-plan', { hasText: 'RektBull\'s fee' }).waitFor();
    await page.click('#o-go');
    await page.waitForFunction(() => { const t = document.getElementById('order-msg').textContent; return t && !/^Signing/.test(t); });
    assert.match(await page.textContent('#order-msg'), /Filled/);
    const order = sent.find(s => s.action.type === 'order');
    assert.deepEqual(order.action.builder, { b: BUILDER, f: 10 });
    const agent = await page.evaluate(k => JSON.parse(localStorage.getItem(k)).address, stored[0]);
    assert.equal(H.recoverL1(order.action, order.signature, { nonce: order.nonce, mainnet: false, expiresAfter: order.expiresAfter }), agent.toLowerCase(), 'signed by the browser\'s key');
    console.log('✔ market order signed in the browser and sent with the fee');

    // Automatic trading: the section says what's enforced where, then the wallet approves RektBull's agent with limits.
    await page.locator('#auto-card').waitFor();
    assert.match(await page.textContent('#auto-rb'), /not onchain/);
    assert.match(await page.textContent('#auto-lose'), /margin in your Hyperliquid account/);
    await page.fill('#a-trade', '200');
    await page.fill('#a-day', '400');
    await page.fill('#a-lev', '2');
    await page.fill('#a-markets', 'btc, eth');
    await page.click('#auto-grant');
    await page.locator('#auto-status', { hasText: 'On until' }).waitFor();
    assert.match(await page.textContent('#auto-status'), /\$200 a trade and \$400 opened in 24 hours.*up to 2x, BTC, ETH/);
    const grant = sent.filter(s => s.action.type === 'approveAgent').at(-1);
    assert.equal(grant.action.agentAddress, agentKey.address.toLowerCase());
    assert.match(grant.action.agentName, /^rektbull-auto valid_until \d+$/);
    if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: true });
    console.log('✔ automatic trading approved with limits');

    // Stop: RektBull stops, and the wallet signs a replacement so Hyperliquid drops the agent.
    await page.click('#auto-revoke');
    await page.locator('#auto-msg', { hasText: 'Stopped' }).waitFor();
    const repl = sent.filter(s => s.action.type === 'approveAgent').at(-1);
    assert.equal(repl.action.agentName.split(' ')[0], 'rektbull-auto');
    assert.notEqual(repl.action.agentAddress, agentKey.address.toLowerCase());
    const { rows: [g] } = await db.query('SELECT status FROM hl_auto_grants');
    assert.equal(g.status, 'revoked');
    console.log('✔ automatic trading stopped, and the agent replaced on Hyperliquid');

    assert.ok(sent.every(s => ['approveAgent', 'approveBuilderFee', 'order'].includes(s.action.type)), 'nothing else was ever sent');
    assert.deepEqual(errors, []);
    console.log('ok: the Perps page, manual and automatic');
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

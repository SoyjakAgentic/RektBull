/**
 * The Predictions page (Polymarket) in a real Chromium: browse, open a
 * market, sign in, get Polymarket API credentials from a wallet signature,
 * and send an order signed by the wallet straight from the browser to
 * Polymarket's order book. The wallet is a stand-in that signs with a test
 * key. Polymarket's APIs are stand-ins answering with recorded data
 * (test/fixtures/polymarket); the browser's own calls to Polymarket are
 * intercepted and checked. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/predictions.js [screenshot.png]
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
const BUILDER = '0x' + 'bb'.repeat(32);
const AI_BUILDER = '0x' + 'ac'.repeat(32);
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '' });
const fx = name => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'polymarket', name), 'utf8'));

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  const env = require('../../src/config/env');
  Object.assign(env, { polymarketEnabled: true, polymarketBuilderCode: BUILDER, polymarketTakerFeeBps: 1, polymarketMakerFeeBps: 1,
    polymarketAiBuilderCode: AI_BUILDER, polymarketAiTakerFeeBps: 100, polymarketAiMakerFeeBps: 50,
    polymarketBuilderApiKey: 'key-id', polymarketBuilderApiSecret: crypto.randomBytes(32).toString('base64'), polymarketBuilderApiPassphrase: 'pass' });

  // The browser's requests carry no country, so Polymarket's own region list would refuse them: clear it here.
  await require('../../src/compliance/regions').set('polymarket', [], { wallet: '0xtest', reason: 'tests run from no country' });
  await require('../../src/compliance/regions').set('polymarket_auto', [], { wallet: '0xtest', reason: 'tests run from no country' });
  // RektBull's side of Polymarket: stand-ins for Gamma, the CLOB's book, the Data API and the relayer.
  const events = fx('events.json');
  const m = events[0].markets[0];
  const pm = require('../../src/providers/polymarket');
  const routes = [['/deployed', () => ({ deployed: true })], ['/markets', () => [m]], ['/book', () => fx('book.json')], ['/v2/positions', () => fx('positions.json')], ['/events', () => events]];
  const answer = async url => { for (const [k, fn] of routes) if (url.includes(k)) return { data: fn() }; throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: {} } }); };
  pm.http.get = url => answer(url);
  pm.http.post = url => answer(url);
  require('../../src/providers/rpc').evmRpc = async (_c, _m, [{ data }]) => {
    const sel = data.slice(0, 10);
    if (sel === '0x70a08231') return ethers.toBeHex(250_000000n, 32); // pUSD balance
    return ethers.toBeHex(sel === '0xdd62ed3e' ? ethers.MaxUint256 : 1n, 32); // every approval in place
  };

  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const wallet = ethers.Wallet.createRandom();
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

  // Polymarket itself, as the browser reaches it: the geoblock check, credentials, the order book.
  const creds = { apiKey: crypto.randomUUID(), secret: crypto.randomBytes(32).toString('base64url'), passphrase: 'pp' };
  const seen = { auth: null, order: null };
  await page.route('https://polymarket.com/api/geoblock', r => r.fulfill({ json: { blocked: false, country: 'PT' } }));
  await page.route('https://clob.polymarket.com/**', async r => {
    const req = r.request();
    const u = new URL(req.url());
    if (u.pathname === '/auth/derive-api-key') { seen.auth = req.headers(); return r.fulfill({ json: creds }); }
    if (u.pathname === '/order' && req.method() === 'POST') { seen.order = { headers: req.headers(), body: req.postData() }; return r.fulfill({ json: { success: true, orderID: '0x' + 'ab'.repeat(32), status: 'matched', errorMsg: '' } }); }
    return r.fulfill({ status: 404, json: { error: 'not in this test' } });
  });

  await page.exposeFunction('__sign', async hex => wallet.signMessage(ethers.getBytes(hex)));
  await page.exposeFunction('__signTyped', async json => { const t = JSON.parse(json); const { EIP712Domain, ...types } = t.types; return wallet.signTypedData(t.domain, types, t.message); });
  await page.addInitScript(addr => {
    let chainId = '0x1';
    const provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
        if (method === 'eth_chainId') return chainId;
        if (method === 'wallet_switchEthereumChain') { chainId = params[0].chainId; return null; }
        if (method === 'personal_sign') return window.__sign(params[0]);
        if (method === 'eth_signTypedData_v4') return window.__signTyped(params[1]);
        throw new Error('stand-in wallet: ' + method);
      },
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test', name: 'Test Wallet' }, provider } })));
  }, wallet.address);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  try {
    await page.goto(url + '/predictions');
    await page.locator('#events .chip').first().waitFor();
    assert.match(await page.textContent('#events-msg'), /Source:/);
    assert.match(await page.textContent('#fee-how'), /0\.01% of what fills.*only on fills/);
    await page.locator('#events .chip').first().click();
    await page.locator('#market-card #book table').waitFor();
    assert.match(await page.textContent('#mk-resolution'), /How it resolves/);
    console.log('✔ markets, a market, its book and how it resolves');

    await page.getByRole('button', { name: 'Connect Test Wallet' }).click();
    await page.getByRole('button', { name: 'Sign in with this wallet' }).click();
    await page.getByText('Signed in.').waitFor();
    await page.locator('#w-status', { hasText: 'Ready to trade' }).waitFor();
    console.log('✔ signed in; the Polymarket wallet is ready');

    // A market buy: prepared by RektBull, signed by the wallet, sent from the browser to Polymarket.
    await page.fill('#o-usd', '1');
    await page.click('#o-prepare');
    await page.locator('#o-plan', { hasText: 'Fees:' }).waitFor();
    if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: true });
    await page.click('#o-go');
    await page.locator('#order-msg', { hasText: 'Sent: filled' }).waitFor();

    // Credentials: from a ClobAuth signature by the wallet itself.
    assert.equal(seen.auth.poly_address, wallet.address);
    const authAddr = ethers.verifyTypedData({ name: 'ClobAuthDomain', version: '1', chainId: 137 }, { ClobAuth: [{ name: 'address', type: 'address' }, { name: 'timestamp', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'message', type: 'string' }] },
      { address: wallet.address, timestamp: seen.auth.poly_timestamp, nonce: 0, message: 'This message attests that I control the given wallet' }, seen.auth.poly_signature);
    assert.equal(authAddr, wallet.address);
    // The order: owner is the API key; L2 headers carry the HMAC of timestamp + method + path + body.
    const h = seen.order.headers;
    const body = JSON.parse(seen.order.body);
    assert.equal(body.owner, creds.apiKey);
    assert.equal(body.order.builder, BUILDER, 'RektBull\'s builder code is in the signed order');
    assert.equal(h.poly_api_key, creds.apiKey);
    const mac = crypto.createHmac('sha256', Buffer.from(creds.secret, 'base64url')).update(h.poly_timestamp + 'POST' + '/order' + seen.order.body).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
    assert.equal(h.poly_signature, mac);
    assert.ok(body.order.signature.length > 132, 'a Deposit Wallet signature carries its ERC-7739 suffix');
    const { rows: [o] } = await db.query('SELECT status, clob_status, clob_order_id FROM polymarket_orders');
    assert.deepEqual([o.status, o.clob_status], ['submitted', 'matched']);
    console.log('✔ order signed by the wallet and sent from the browser, credentials never on the server');

    const { rows } = await db.query('SELECT prepared::text AS p FROM polymarket_orders');
    assert.ok(!rows[0].p.includes(creds.secret) && !rows[0].p.includes(creds.apiKey), 'the server never stored the credentials');

    // An AI proposal: shown with its reasoning and sources; reviewing it fills in a limit order the user then signs.
    const { rows: [acct] } = await db.query('SELECT id FROM accounts WHERE wallet = $1', [wallet.address.toLowerCase()]);
    await db.query(`INSERT INTO passes (account_id, product, starts_at, ends_at) VALUES ($1, 'pro_30d', now(), now() + interval '30 days')`, [acct.id]);
    await require('../../src/forecasts/proposals').saveSettings(acct.id, { polymarket: true });
    const outcome0 = JSON.parse(m.outcomes)[0];
    const asset0 = JSON.parse(m.clobTokenIds)[0];
    const { rows: [f] } = await db.query(`INSERT INTO ai_forecasts (venue, stage, market, question, outcome, asset_id, ai_prob, market_prob, confidence, reasoning, sources, model, cost_usd)
      VALUES ('polymarket', 'research', $1, $2, $3, $4, 0.6, 0.02, 'medium', 'The evidence points higher than the price.', '["https://news.example/a"]', 'claude-sonnet-5-5', 0.12) RETURNING *`, [m.slug, m.question, outcome0, asset0]);
    await require('../../src/forecasts/proposals').offer(acct.id, { forecast: f, side: outcome0, assetId: asset0, priceLimit: 0.03, priceUsd: 0.25 });
    await page.reload();
    await page.locator('#ai-list', { hasText: 'The evidence points higher' }).waitFor();
    assert.match(await page.textContent('#ai-list'), /news\.example/);
    assert.match(await page.textContent('#ai-credits'), /AI credits/);
    assert.equal((await require('../../src/payments/aiAllowance').status(acct.id)).used_usd, 0, 'seeing a proposal is free');
    await page.getByRole('button', { name: 'Review the order ($0.25)' }).click();
    await page.locator('#order-msg', { hasText: 'Filled in from the AI proposal' }).waitFor();
    assert.equal(await page.inputValue('#o-type'), 'GTC');
    assert.equal(await page.inputValue('#o-price'), '0.03');
    assert.equal(await page.inputValue('#o-outcome'), asset0);
    const { rows: [pr] } = await db.query('SELECT id, status, paid_from FROM ai_proposals');
    assert.deepEqual([pr.status, pr.paid_from], ['approved', 'allowance']);
    assert.equal((await require('../../src/payments/aiAllowance').status(acct.id)).used_usd, 0.25, 'acting on it: $0.25 of AI credits');
    // The order from it carries RektBull's AI builder code, at its rates, and names the proposal.
    await page.fill('#o-size', '10');
    await page.click('#o-prepare');
    await page.locator('#o-plan', { hasText: 'Fees:' }).waitFor();
    assert.match(await page.textContent('#o-plan'), /1% of what fills when the order takes liquidity, 0\.5% when it rests/);
    const { rows: [ao] } = await db.query(`SELECT builder, source, rule_id FROM polymarket_orders WHERE source = 'rule'`);
    assert.deepEqual([ao.builder, ao.rule_id], [AI_BUILDER, pr.id]);
    await page.fill('#o-price', '0.05');
    await page.click('#o-prepare');
    await page.locator('#order-msg', { hasText: 'more than the proposal\'s limit' }).waitFor();
    console.log('✔ an AI proposal, reviewed into an order for the user to sign');

    // Automatic trading: every disclosure shown before signing; the user's own key authorizes RektBull's Session Key; stopping is one button.
    const sessionKey = ethers.Wallet.createRandom();
    Object.assign(env, { polymarketAutoEnabled: true, polymarketSessionAddress: sessionKey.address.toLowerCase() });
    routes.unshift(['/transactions/params', () => ({ nonce: '7' })], ['/session-signers/authorizations', () => ({ transactionID: 'rel-auth' })],
      ['/session-signers/revocations', () => ({ transactionID: 'rel-revoke' })], ['/account/transactions/', () => ({ state: 'STATE_CONFIRMED' })]);
    await page.reload();
    await page.locator('#auto-disclosures', { hasText: 'fixed term of 180 days' }).waitFor();
    await page.getByRole('button', { name: 'Connect Test Wallet' }).click();
    const told = await page.textContent('#auto-disclosures');
    for (const want of [/not onchain/, /Only buys/, /at least \$25/, /AI builder fee of 1% of what fills/, /automation fee of 1% of what fills, at least \$0\.25/, /Polymarket wallet/, /checks your country/]) assert.match(told, want);
    await page.click('#auto-start');
    await page.locator('#auto-msg', { hasText: 'tick the box' }).waitFor();
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM polymarket_sessions')).rows[0].n, 0, 'nothing prepared before the user accepts');
    await page.fill('#auto-max-order', '40'); await page.fill('#auto-max-day', '120'); await page.fill('#auto-days', '14');
    await page.check('#auto-accept');
    await page.click('#auto-start');
    await page.locator('#auto-session', { hasText: 'On.' }).waitFor({ timeout: 20000 });
    assert.match(await page.textContent('#auto-session'), /At most \$40 an order and \$120 in 24 hours, kept by RektBull's servers, not onchain/);
    const { rows: [b] } = await db.query(`SELECT * FROM polymarket_batches WHERE kind = 'session_authorize'`);
    assert.equal(b.status, 'confirmed');
    assert.equal(b.detail.session_signer, sessionKey.address.toLowerCase());
    assert.equal(ethers.AbiCoder.defaultAbiCoder().decode(['address', 'uint256'], '0x' + b.calls[0].data.slice(10))[0], sessionKey.address, 'authorizes RektBull\'s key, nothing else');
    await page.click('#auto-stop');
    await page.locator('#auto-session', { hasText: 'revoked' }).waitFor({ timeout: 20000 });
    const { rows: [rv] } = await db.query(`SELECT status FROM polymarket_batches WHERE kind = 'session_revoke'`);
    assert.equal(rv.status, 'confirmed');
    console.log('✔ automatic trading: disclosed, authorized by the user\'s key, stopped with one button');
    assert.deepEqual(errors, []);
    console.log('ok: the Predictions page');
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

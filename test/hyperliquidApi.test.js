/**
 * The Perps page's API: the relay's rules (hyperliquid/relay.js) on requests
 * signed with keys made at run time, and the routes through the app.
 * Hyperliquid is a stand-in that records what it's sent; the market data is a
 * real answer recorded from its info API (test/fixtures/hyperliquid). The
 * signed-in routes run against Postgres when TEST_DATABASE_URL is set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
const BUILDER = '0x' + 'b1'.repeat(20);
Object.assign(process.env, { JWT_SECRET: 'test-secret', NEW_WALLET_CHECK_CHAINS: '', PUBLIC_URL: 'https://rektbull.test', HL_ENABLED: 'true', HL_NETWORK: 'testnet', DATABASE_URL: DB || '' });
require('../src/providers/llama').protocols = async () => [];
const H = require('../public/hl-core.js');
const hl = require('../src/providers/hyperliquid');
const relay = require('../src/hyperliquid/relay');
const env = require('../src/config/env');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hyperliquid', `${name}.json`), 'utf8'));
const user = ethers.Wallet.createRandom();
const agent = ethers.Wallet.createRandom();
const wallet = user.address.toLowerCase();

/** A request the page would send: an L1 action signed by the browser's agent key. */
async function l1(action, over = {}) {
  const nonce = over.nonce ?? Date.now();
  const expiresAfter = nonce + 30000;
  return { action, nonce, signature: await H.signL1(agent, action, { nonce, mainnet: false, expiresAfter }), expiresAfter, ...over };
}
/** An approval signed by a wallet. */
async function approval(action, signer = user) {
  const t = H.userTypedData(action);
  return { action, nonce: action.nonce, signature: H.wireSignature(await signer.signTypedData(t.domain, t.types, t.message)) };
}
const order = (o = {}) => H.orderWire({ asset: 0, isBuy: true, px: '65000', sz: '0.001', tif: 'Ioc', ...o });
const refused = (fn, code, why) => assert.throws(fn, err => err instanceof relay.RelayRefused && (!code || err.code === code) && (!why || why.test(err.message)), String(why || code));

test('the relay: what it carries and what it refuses', async () => {
  const ctx = { wallet };
  const open = relay.check(await l1(H.orderAction([order()])), ctx);
  assert.deepEqual([open.type, open.opens, open.approves], ['order', true, false]);
  assert.deepEqual(Object.keys(open.payload), ['action', 'nonce', 'signature', 'expiresAfter'], 'only what Hyperliquid needs is passed on');
  assert.equal(relay.check(await l1(H.orderAction([order({ reduceOnly: true })])), ctx).opens, false, 'a reduce-only order can only close');
  const tpsl = H.orderAction([order({ isBuy: false, reduceOnly: true, tif: undefined, trigger: { triggerPx: '70000', isMarket: true, tpsl: 'tp' } })]);
  assert.equal(relay.check(await l1(tpsl), ctx).opens, false);
  refused(() => relay.check({ action: H.orderAction([order({ tif: undefined, trigger: { triggerPx: '70000', isMarket: true, tpsl: 'tp' } })]), nonce: Date.now(), signature: { r: '0x1', s: '0x2', v: 27 } }, ctx), 'not_reduce_only', /must be reduce-only/);
  for (const a of [H.cancelAction([{ asset: 0, oid: 77738308 }]), { type: 'cancelByCloid', cancels: [{ asset: 0, cloid: H.cloid() }] }, H.updateLeverageAction({ asset: 0, isCross: true, leverage: 5 }), { type: 'updateIsolatedMargin', asset: 0, isBuy: true, ntli: 1000000 }]) {
    const c = relay.check(await l1(a), ctx);
    assert.deepEqual([c.type, c.opens, c.approves], [a.type, false, false]);
  }

  // Whatever is signed, nothing that moves money is carried.
  for (const type of ['withdraw3', 'usdSend', 'spotSend', 'usdClassTransfer', 'sendAsset', 'vaultTransfer', 'subAccountTransfer', 'createSubAccount', 'twapOrder', 'setReferrer']) {
    refused(() => relay.check({ action: { type, destination: wallet, amount: '100', time: Date.now() }, nonce: Date.now(), signature: { r: '0x1', s: '0x2', v: 27 } }, ctx), 'action_not_relayed', /never relays/);
  }
  const base = await l1(H.orderAction([order()]));
  refused(() => relay.check({ ...base, vaultAddress: '0x' + '11'.repeat(20) }, ctx), null, /vaults or subaccounts/);
  refused(() => relay.check({ ...base, nonce: Date.now() - 3 * 86400000 }, ctx), null, /too far from the current time/);
  refused(() => relay.check({ ...base, signature: { r: '0x1', s: '0x2', v: 1 } }, ctx), null, /signature/);
  refused(() => relay.check({ ...base, action: { ...base.action, extra: 1 } }, ctx), null, /doesn't relay: extra/);
  refused(() => relay.check({ ...base, action: H.orderAction([{ ...order(), a: 10000 }]) }, ctx), null, /perp market/);
  refused(() => relay.check({ ...base, action: H.orderAction([{ ...order(), p: '-5' }]) }, ctx), null, /positive numbers/);
  refused(() => relay.check({ ...base, action: H.orderAction(Array.from({ length: 21 }, () => order())) }, ctx), null, /1 to 20/);
  refused(() => relay.check({ ...base, action: H.updateLeverageAction({ asset: 0, isCross: true, leverage: 0 }) }, ctx), null, /leverage/);

  // Approvals: only when the signed-in wallet signed them, and only for this network.
  const approve = H.approveAgentAction({ mainnet: false, signatureChainId: 42161, agentAddress: agent.address, name: 'rektbull-web', validUntilMs: Date.now() + 30 * 86400000, nonce: Date.now() });
  const ok = relay.check(await approval(approve), ctx);
  assert.deepEqual([ok.type, ok.opens, ok.approves], ['approveAgent', false, true]);
  refused(() => relay.check({ ...ok.payload }, { wallet: '0x' + '22'.repeat(20) }), 'wrong_signer', /isn't signed by the wallet you're signed in with/);
  const forged = await approval(approve, ethers.Wallet.createRandom());
  refused(() => relay.check(forged, ctx), 'wrong_signer');
  const mainnetOne = H.approveAgentAction({ mainnet: true, signatureChainId: 42161, agentAddress: agent.address, name: 'rektbull-web', nonce: Date.now() });
  refused(() => relay.check({ action: mainnetOne, nonce: mainnetOne.nonce, signature: { r: '0x1', s: '0x2', v: 27 } }, ctx), null, /signed for Mainnet/);
  const tooLong = H.approveAgentAction({ mainnet: false, signatureChainId: 1, agentAddress: agent.address, name: 'rektbull-web', validUntilMs: Date.now() + 181 * 86400000, nonce: Date.now() });
  refused(() => relay.check({ action: tooLong, nonce: tooLong.nonce, signature: { r: '0x1', s: '0x2', v: 27 } }, ctx), null, /at most 180 days/);
  const fee = relay.check(await approval(H.approveBuilderFeeAction({ mainnet: false, signatureChainId: 8453, builder: BUILDER, tenthsBps: 10, nonce: Date.now() })), ctx);
  assert.equal(fee.type, 'approveBuilderFee');

  assert.deepEqual(relay.summarize({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.02', avgPx: '1891.4', oid: 77747314 } }, { resting: { oid: 77738308 } }, { error: 'Order must have minimum value of $10.' }] } } }),
    [{ filled: true, size: 0.02, avg_px: 1891.4, oid: 77747314 }, { resting: true, oid: 77738308 }, { error: 'Order must have minimum value of $10.' }]);
});

test('sending: Hyperliquid\'s answer comes back, and its refusal says why', async () => {
  const sent = [];
  let answer = { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.001', avgPx: '64990', oid: 9 } }] } } };
  hl._reset();
  hl.setTransport(async (p, body) => { sent.push([p, body]); return answer; });
  const req = await l1(H.orderAction([order()]));
  const out = await relay.send(req, { wallet });
  assert.deepEqual(out.results, [{ filled: true, size: 0.001, avg_px: 64990, oid: 9 }]);
  assert.equal(out.source, 'Hyperliquid\'s exchange API');
  assert.equal(sent[0][0], '/exchange');
  assert.deepEqual(sent[0][1], { action: req.action, nonce: req.nonce, signature: req.signature, expiresAfter: req.expiresAfter });
  assert.equal(H.recoverL1(sent[0][1].action, sent[0][1].signature, { nonce: req.nonce, mainnet: false, expiresAfter: req.expiresAfter }), agent.address.toLowerCase(), 'what reaches Hyperliquid is what the browser\'s key signed');
  answer = { status: 'err', response: 'User or API Wallet 0xabc does not exist.' };
  await assert.rejects(relay.send(await l1(H.orderAction([order()])), { wallet }), err => err.code === 'hyperliquid_refused' && /Hyperliquid refused it: User or API Wallet/.test(err.message));
  env.hlEnabled = false;
  const before = sent.length;
  await assert.rejects(relay.send(req, { wallet }), err => err.status === 503 && /switched off/.test(err.message));
  assert.equal(sent.length, before, 'nothing is sent while perps are off');
  env.hlEnabled = true;
});

test('the page and the open routes', async t => {
  hl._reset();
  hl.setTransport(async (_p, body) => { if (body.type === 'metaAndAssetCtxs') return fixture('metaAndAssetCtxs'); throw new Error('ECONNRESET'); });
  const server = require('../src/app').createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async p => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) }; };

  const html = await (await fetch(`${base}/perps`)).text();
  for (const s of ['<title>Hyperliquid Perps From Your Own Account | RektBull</title>', '/hl-core.js', '/perps.js', 'never picks a market or a side', 'It can\'t withdraw or transfer', 'never sent to RektBull']) assert.ok(html.includes(s), s);
  assert.match(html, /<a href="\/trade" aria-current="page">/, 'Perps sits under Trade in the menu');
  assert.match(await (await fetch(`${base}/hl-core.js`)).text(), /HLCore/);
  assert.match(await (await fetch(`${base}/trade`)).text(), /href="\/perps"/);

  const cfg = await get('/v1/hyperliquid/config');
  assert.equal(cfg.status, 200);
  assert.deepEqual([cfg.body.enabled, cfg.body.network, cfg.body.agent.name, cfg.body.agent.days, cfg.body.order.min_usd], [true, 'testnet', 'rektbull-web', 30, 10]);
  assert.equal(cfg.body.deposit_url, 'https://app.hyperliquid-testnet.xyz/trade');

  const m = await get('/v1/hyperliquid/markets');
  assert.equal(m.status, 200);
  assert.equal(m.body.source, 'Hyperliquid\'s info API');
  assert.deepEqual(m.body.markets.map(x => x.coin), ['BTC', 'ETH', 'ATOM', 'DYDX', 'SOL', 'AVAX', 'BNB'], 'delisted markets aren\'t offered');
  assert.equal(m.body.markets.find(x => x.coin === 'ETH').asset, 1, 'asset ids stay Hyperliquid\'s own indexes');

  // Signed out: nothing about an account, and nothing is relayed.
  assert.equal((await get('/v1/hyperliquid/account')).status, 401);
  assert.equal((await fetch(`${base}/v1/hyperliquid/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);

  // Hyperliquid down: the answer says why.
  hl._reset();
  hl.setTransport(async () => { throw new Error('ECONNRESET'); });
  const down = await get('/v1/hyperliquid/markets');
  assert.equal(down.status, 502);
  assert.match(down.body.message, /Hyperliquid's info API didn't answer \(ECONNRESET\)/);
});

test('signed in: the account, approvals and the relay through the app', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  require('../src/admin/settings').reset();
  const { issueToken } = require('../src/auth/siwe');
  const server = require('../src/app').createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [wallet]);
  const { rows: [sol] } = await db.query('INSERT INTO accounts (solana_wallet) VALUES ($1) RETURNING id, wallet, solana_wallet', ['GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB']);
  const call = async (method, p, body, token = issueToken(acct)) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const sent = [];
  const asked = [];
  hl._reset();
  hl.setTransport(async (p, body) => {
    if (p === '/exchange') { sent.push(body); return body.action.type === 'order' ? { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 123 } }] } } } : { status: 'ok', response: { type: 'default' } }; }
    asked.push(body);
    return { clearinghouseState: fixture('clearinghouseState'), frontendOpenOrders: fixture('frontendOpenOrders'), extraAgents: [{ name: 'rektbull-web', address: agent.address, validUntil: Date.now() + 86400000 }], maxBuilderFee: 0 }[body.type];
  });

  const a = await call('GET', '/v1/hyperliquid/account');
  assert.equal(a.status, 200);
  assert.equal(a.body.user, wallet, 'always the signed-in wallet\'s own account');
  assert.ok(asked.every(q => q.user === wallet));
  assert.equal(a.body.positions.length, 3); assert.equal(a.body.open_orders.length, 3);
  const ap = await call('GET', '/v1/hyperliquid/approvals');
  assert.equal(ap.body.agents[0].address, agent.address.toLowerCase());
  assert.equal((await call('GET', '/v1/hyperliquid/account', null, issueToken(sol))).body.error, 'evm_wallet_required');

  const approve = H.approveAgentAction({ mainnet: false, signatureChainId: 42161, agentAddress: agent.address, name: 'rektbull-web', validUntilMs: Date.now() + 30 * 86400000, nonce: Date.now() });
  assert.equal((await call('POST', '/v1/hyperliquid/exchange', await approval(approve))).status, 200);
  assert.equal(sent[0].action.type, 'approveAgent');
  const placed = await call('POST', '/v1/hyperliquid/exchange', await l1(H.orderAction([order({ tif: 'Gtc' })])));
  assert.equal(placed.status, 200);
  assert.deepEqual(placed.body.results, [{ resting: true, oid: 123 }]);
  const w = await call('POST', '/v1/hyperliquid/exchange', { action: { type: 'withdraw3', hyperliquidChain: 'Testnet', signatureChainId: '0xa4b1', amount: '100', time: Date.now(), destination: wallet }, nonce: Date.now(), signature: { r: '0x1', s: '0x2', v: 27 } });
  assert.equal(w.status, 422); assert.equal(w.body.error, 'action_not_relayed');
  assert.equal(sent.length, 2, 'the withdrawal never reached Hyperliquid');
  const other = await call('POST', '/v1/hyperliquid/exchange', await approval(approve, ethers.Wallet.createRandom()));
  assert.equal(other.status, 403); assert.equal(other.body.error, 'wrong_signer');
});

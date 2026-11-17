/**
 * Automatic perps trading (hyperliquid/auto.js), against Postgres
 * (TEST_DATABASE_URL) and a stand-in Hyperliquid that records what it's sent.
 * Market data is the real answer recorded in test/fixtures/hyperliquid.
 * RektBull's agent key is a throwaway made at run time.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
const agentKey = ethers.Wallet.createRandom();
Object.assign(process.env, {
  JWT_SECRET: 'test-secret', NEW_WALLET_CHECK_CHAINS: '', PUBLIC_URL: 'https://rektbull.test', DATABASE_URL: DB || '',
  HL_ENABLED: 'true', HL_NETWORK: 'testnet', HL_AUTO_ENABLED: 'true', HL_AGENT_ADDRESS: agentKey.address,
  HL_BUILDER_ADDRESS: '0x' + 'b1'.repeat(20), HL_BUILDER_FEE_TENTHS_BPS: '10',
});
require('../src/providers/llama').protocols = async () => [];
const H = require('../public/hl-core.js');
const hl = require('../src/providers/hyperliquid');
const env = require('../src/config/env');
const auto = require('../src/hyperliquid/auto');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hyperliquid', `${name}.json`), 'utf8'));
const user = ethers.Wallet.createRandom();
const wallet = user.address.toLowerCase();
const DAY = 86400000;

async function approval(action, signer = user) {
  const t = H.userTypedData(action);
  return { action, nonce: action.nonce, signature: H.wireSignature(await signer.signTypedData(t.domain, t.types, t.message)) };
}
const grantApproval = (days = 30, agentAddress = agentKey.address, name = auto.AGENT_NAME) => approval(H.approveAgentAction({ mainnet: false, signatureChainId: 42161, agentAddress, name, validUntilMs: Date.now() + days * DAY, nonce: Date.now() }));
const LIMITS = { max_trade_usd: 500, max_day_usd: 800, max_leverage: 5, markets: null };

test('the settings a user may choose, and the approval RektBull accepts', () => {
  assert.deepEqual(auto.checkLimits(LIMITS), LIMITS);
  assert.throws(() => auto.checkLimits({ ...LIMITS, max_trade_usd: 5 }), /max_trade_usd/);
  assert.throws(() => auto.checkLimits({ ...LIMITS, max_day_usd: 100 }), /at least max_trade_usd/);
  assert.throws(() => auto.checkLimits({ ...LIMITS, max_leverage: env.hlAutoMaxLeverage + 1 }), /max_leverage/);
  assert.throws(() => auto.checkLimits({ ...LIMITS, markets: ['BTC', 'not a coin!'] }), /markets/);
  const a = days => H.approveAgentAction({ mainnet: false, signatureChainId: 1, agentAddress: agentKey.address, name: auto.AGENT_NAME, validUntilMs: Date.now() + days * DAY, nonce: 1 });
  assert.ok(auto.grantValidUntil(a(30)) > Date.now());
  assert.throws(() => auto.grantValidUntil(a(31)), /an hour to 30 days/);
  assert.throws(() => auto.grantValidUntil({ ...a(30), agentAddress: '0x' + '22'.repeat(20) }), /isn't RektBull's/);
  assert.throws(() => auto.grantValidUntil({ ...a(30), agentName: 'rektbull-auto' }), /with an expiry/);
  const s = auto.status();
  assert.equal(s.enabled, true);
  assert.match(s.enforced_by_rektbull, /not onchain/);
  assert.match(s.enforced_by_hyperliquid, /never withdraw or transfer/);
  assert.match(s.most_you_can_lose, /margin in your Hyperliquid account/);
});

test('granting, queueing, sending and revoking', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
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
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${issueToken(acct)}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // The stand-in Hyperliquid.
  const sent = [];
  let positions = [];
  let builderApproved = 10;
  let meta = fixture('metaAndAssetCtxs');
  let fill = { totalSz: '0.00764', avgPx: '65400' };
  hl._reset();
  hl.setTransport(async (p, body) => {
    if (p === '/exchange') {
      sent.push(body);
      if (body.action.type === 'order') {
        return { status: 'ok', response: { type: 'order', data: { statuses: body.action.orders.map(o => (o.t.trigger ? { resting: { oid: 2 } } : fill ? { filled: { ...fill, oid: 1 } } : { error: 'Order could not immediately match against any resting orders.' })) } } };
      }
      return { status: 'ok', response: { type: 'default' } };
    }
    return {
      metaAndAssetCtxs: meta,
      clearinghouseState: { marginSummary: { accountValue: '1000', totalMarginUsed: '0', totalNtlPos: '0' }, withdrawable: '1000', assetPositions: positions, time: Date.now() },
      frontendOpenOrders: [], extraAgents: [], maxBuilderFee: builderApproved,
    }[body.type];
  });
  auto.setSignerForTests(agentKey);
  t.after(() => auto.setSignerForTests(null));

  // Before a grant, nothing can be queued.
  const none = await call('POST', '/v1/hyperliquid/auto/intents', { coin: 'BTC', side: 'long', size_usd: 100, leverage: 2 });
  assert.equal(none.status, 409); assert.equal(none.body.error, 'no_grant');

  // RektBull's agent can't be approved through the plain relay: only with limits.
  const plain = await call('POST', '/v1/hyperliquid/exchange', await grantApproval());
  assert.equal(plain.status, 422); assert.equal(plain.body.error, 'use_auto_grant');
  // Signed by someone else's wallet: refused, nothing recorded.
  const forged = await call('POST', '/v1/hyperliquid/auto/grant', { approval: await approval((await grantApproval()).action, ethers.Wallet.createRandom()), limits: LIMITS });
  assert.equal(forged.status, 403);
  assert.equal(sent.length, 0);

  const g = await call('POST', '/v1/hyperliquid/auto/grant', { approval: await grantApproval(), limits: LIMITS });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal(g.body.max_trade_usd, 500); assert.equal(g.body.agent_address, agentKey.address.toLowerCase());
  assert.equal(sent.at(-1).action.type, 'approveAgent');

  // The limits, checked when queued.
  const q = body => call('POST', '/v1/hyperliquid/auto/intents', body);
  assert.equal((await q({ coin: 'BTC', side: 'long', size_usd: 600, leverage: 2 })).body.error, 'over_trade_limit');
  assert.equal((await q({ coin: 'BTC', side: 'long', size_usd: 100, leverage: 6 })).body.error, 'over_leverage');
  assert.equal((await q({ coin: 'ATOM', side: 'long', size_usd: 100, leverage: 2 })).body.error, 'market_not_deep', 'thin markets: no automatic opens');
  assert.equal((await q({ coin: 'BTC', side: 'long', size_usd: 100, leverage: 2, stop_loss_pct: 60 })).status, 400, 'a stop past liquidation');

  // A long with a stop: leverage set to isolated, an IOC within the band, carrying RektBull's fee, then the stop.
  const long = await q({ coin: 'BTC', side: 'long', size_usd: 500, leverage: 2, stop_loss_pct: 5 });
  assert.equal(long.status, 201, JSON.stringify(long.body));
  const before = sent.length;
  await auto.tick();
  const [lev, entry, exits] = sent.slice(before);
  assert.deepEqual(lev.action, { type: 'updateLeverage', asset: 0, isCross: false, leverage: 2 });
  assert.equal(entry.action.orders[0].t.limit.tif, 'Ioc');
  assert.equal(entry.action.orders[0].r, false);
  const px = Number(entry.action.orders[0].p);
  assert.ok(px > 65365 && px <= 65365 * 1.005 + 1, `within 0.5% of the mark: ${px}`);
  assert.deepEqual(entry.action.builder, { b: env.hlBuilderAddress, f: 10 });
  assert.equal(exits.action.orders[0].r, true, 'the stop is reduce-only');
  assert.equal(exits.action.orders[0].t.trigger.tpsl, 'sl');
  assert.ok(Number(exits.action.orders[0].t.trigger.triggerPx) < 65400);
  for (const s of sent.slice(before)) {
    assert.equal(H.recoverL1(s.action, s.signature, { nonce: s.nonce, mainnet: false, expiresAfter: s.expiresAfter }), agentKey.address.toLowerCase(), 'signed by RektBull\'s agent');
  }
  const { rows: sigs } = await db.query('SELECT purpose FROM key_signatures ORDER BY id');
  assert.deepEqual(sigs.map(s => s.purpose.split(':')[2]), ['updateLeverage', 'order', 'order'], 'each signature logged first');
  let ov = (await call('GET', '/v1/hyperliquid/auto')).body;
  assert.equal(ov.intents[0].status, 'done');
  assert.equal(ov.intents[0].filled_usd, Math.round(0.00764 * 65400 * 100) / 100);

  // The 24-hour amount counts what was opened.
  assert.equal((await q({ coin: 'ETH', side: 'long', size_usd: 500, leverage: 2 })).body.error, 'over_day_limit');

  // The price band: a mark far from the oracle means nothing is sent.
  meta = JSON.parse(JSON.stringify(meta));
  meta[1][5].markPx = String(Number(meta[1][5].oraclePx) * 1.02);
  const sol = await q({ coin: 'SOL', side: 'short', size_usd: 100, leverage: 1 });
  const n0 = sent.length;
  await auto.tick();
  assert.equal(sent.length, n0, 'nothing sent');
  ov = (await call('GET', '/v1/hyperliquid/auto')).body;
  assert.match(ov.intents.find(i => i.id === sol.body.id).error, /more than 0.5% apart/);
  meta = fixture('metaAndAssetCtxs');

  // The fee must be approved before an automatic open.
  builderApproved = 0;
  await q({ coin: 'ETH', side: 'long', size_usd: 100, leverage: 1 });
  await auto.tick();
  ov = (await call('GET', '/v1/hyperliquid/auto')).body;
  assert.match(ov.intents[0].error, /fee isn't approved/);
  builderApproved = 10;

  // A cross-margin position already open: not touched.
  positions = [{ type: 'oneWay', position: { coin: 'ETH', szi: '0.1', entryPx: '1800', positionValue: '183', unrealizedPnl: '3', liquidationPx: null, marginUsed: '183', leverage: { type: 'cross', value: 1 }, maxLeverage: 25, cumFunding: { sinceOpen: '0' } } }];
  await q({ coin: 'ETH', side: 'long', size_usd: 100, leverage: 1 });
  await auto.tick();
  ov = (await call('GET', '/v1/hyperliquid/auto')).body;
  assert.match(ov.intents[0].error, /isolated margin/);

  // Closing: reduce-only, the whole position.
  const n1 = sent.length;
  await q({ coin: 'ETH', side: 'close' });
  await auto.tick();
  const close = sent[n1];
  assert.equal(close.action.orders[0].r, true); assert.equal(close.action.orders[0].b, false); assert.equal(close.action.orders[0].s, '0.1');
  positions = [];

  // Region blocks stop opening, never closing.
  const regions = require('../src/compliance/regions');
  const hdr = env.geoCountryHeader;
  env.geoCountryHeader = 'X-Test-Country';
  t.after(() => { env.geoCountryHeader = hdr; });
  await regions.set('hyperliquid', ['US'], { wallet: '0xadmin', reason: 'test' });
  assert.equal((await call('POST', '/v1/hyperliquid/auto/intents', { coin: 'BTC', side: 'long', size_usd: 20, leverage: 1 }, { 'x-test-country': 'US' })).status, 451);
  assert.equal((await call('POST', '/v1/hyperliquid/auto/intents', { coin: 'BTC', side: 'close' }, { 'x-test-country': 'US' })).status, 201);
  await regions.set('hyperliquid', [], { wallet: '0xadmin', reason: 'test' });

  // The emergency stop: what's queued is cancelled, nothing is sent.
  const stops = require('../src/admin/stops');
  await q({ coin: 'BTC', side: 'long', size_usd: 20, leverage: 1 });
  await stops.set('auto_trading', true, { wallet: '0xadmin', reason: 'test' });
  const n2 = sent.length;
  await auto.tick();
  assert.equal(sent.length, n2);
  ov = (await call('GET', '/v1/hyperliquid/auto')).body;
  assert.equal(ov.intents[0].status, 'cancelled');
  assert.equal((await q({ coin: 'BTC', side: 'long', size_usd: 20, leverage: 1 })).body.error, 'stopped');
  await stops.set('auto_trading', false, { wallet: '0xadmin', reason: 'test' });

  // Revoking: RektBull stops at once; the replacement ends the agent on Hyperliquid.
  await q({ coin: 'BTC', side: 'long', size_usd: 20, leverage: 1 });
  const dead = ethers.Wallet.createRandom().address;
  const r = await call('POST', '/v1/hyperliquid/auto/revoke', { approval: await grantApproval(1, dead) });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.revoked, true);
  assert.equal(sent.at(-1).action.agentAddress, dead.toLowerCase());
  ov = (await call('GET', '/v1/hyperliquid/auto')).body;
  assert.equal(ov.grant.status, 'revoked');
  assert.equal(ov.intents[0].status, 'cancelled');
  assert.equal((await q({ coin: 'BTC', side: 'long', size_usd: 20, leverage: 1 })).body.error, 'no_grant');

  // Nothing RektBull's agent signed was ever a transfer or withdrawal.
  assert.ok(sent.every(s => ['approveAgent', 'order', 'updateLeverage'].includes(s.action.type)));
});

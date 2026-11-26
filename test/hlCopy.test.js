/**
 * Copy trading on Hyperliquid (hyperliquid/copy.js), against Postgres
 * (TEST_DATABASE_URL) and a stand-in Hyperliquid that records what it's sent.
 * Market data is the real answer recorded in test/fixtures/hyperliquid.
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
  HL_ENABLED: 'true', HL_NETWORK: 'testnet', HL_AUTO_ENABLED: 'true', HL_COPY_ENABLED: 'true', HL_AGENT_ADDRESS: agentKey.address,
  HL_BUILDER_ADDRESS: '0x' + 'b1'.repeat(20), HL_BUILDER_FEE_TENTHS_BPS: '10',
});
require('../src/providers/llama').protocols = async () => [];
const H = require('../public/hl-core.js');
const hl = require('../src/providers/hyperliquid');
const env = require('../src/config/env');
const auto = require('../src/hyperliquid/auto');
const copy = require('../src/hyperliquid/copy');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hyperliquid', `${name}.json`), 'utf8'));
const user = ethers.Wallet.createRandom();
const wallet = user.address.toLowerCase();
const leader = ethers.Wallet.createRandom().address.toLowerCase();
const DAY = 86400000;

async function approval(action, signer = user) {
  const t = H.userTypedData(action);
  return { action, nonce: action.nonce, signature: H.wireSignature(await signer.signTypedData(t.domain, t.types, t.message)) };
}
const grantApproval = () => approval(H.approveAgentAction({ mainnet: false, signatureChainId: 42161, agentAddress: agentKey.address, name: auto.AGENT_NAME, validUntilMs: Date.now() + 30 * DAY, nonce: Date.now() }));
const LIMITS = { max_trade_usd: 200, max_day_usd: 1000, max_leverage: 5, markets: null };
/** A position as Hyperliquid's clearinghouseState gives it. */
const pos = (coin, szi, entryPx, lev = 3, pnl = '0') => ({ type: 'oneWay', position: { coin, szi: String(szi), entryPx: String(entryPx), positionValue: String(Math.abs(szi * entryPx)), unrealizedPnl: pnl, liquidationPx: null, marginUsed: '1', leverage: { type: 'isolated', value: lev }, maxLeverage: 40, cumFunding: { sinceOpen: '0' } } });

test('copy trading: following a trader, copying their opens and closes, and stopping', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  require('../src/admin/settings').reset();
  await require('../src/compliance/regions').set('hyperliquid', [], { wallet: '0xtest', reason: 'tests run from no country' });
  const { issueToken } = require('../src/auth/siwe');
  const server = require('../src/app').createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [wallet]);
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${issueToken(acct)}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // The stand-in Hyperliquid: the follower's and the trader's positions, and what's sent.
  const sent = [];
  const held = { [wallet]: [], [leader]: [pos('ETH', 2, 1800)] };
  let leaderDown = false;
  let builderApproved = 10;
  const fill = { totalSz: '0.0015', avgPx: '65400' };
  hl._reset();
  hl.setTransport(async (p, body) => {
    if (p === '/exchange') {
      sent.push(body);
      if (body.action.type === 'order') return { status: 'ok', response: { type: 'order', data: { statuses: body.action.orders.map(o => (o.t.trigger ? { resting: { oid: 2 } } : { filled: { ...fill, oid: 1 } })) } } };
      return { status: 'ok', response: { type: 'default' } };
    }
    if (body.type === 'clearinghouseState') {
      if (body.user === leader && leaderDown) throw Object.assign(new Error('socket hang up'), { response: { status: 502 } });
      return { marginSummary: { accountValue: body.user === leader ? '25000' : '1000', totalMarginUsed: '0', totalNtlPos: '0' }, withdrawable: '1000', assetPositions: held[body.user] || [], time: Date.now() };
    }
    if (body.type === 'portfolio') return [['perpMonth', { accountValueHistory: [[1, '20000'], [2, '25000']], pnlHistory: [[1, '0.0'], [2, '4200.5']], vlm: '900000' }], ['perpAllTime', { accountValueHistory: [], pnlHistory: [[1, '0.0'], [2, '-310']], vlm: '5000000' }]];
    return { metaAndAssetCtxs: fixture('metaAndAssetCtxs'), frontendOpenOrders: [], extraAgents: [], maxBuilderFee: builderApproved }[body.type];
  });
  auto.setSignerForTests(agentKey);
  t.after(() => auto.setSignerForTests(null));
  const FOLLOW = { leader, trade_usd: 100, max_leverage: 3, stop_loss_pct: 5 };
  const trades = async () => (await call('GET', '/v1/hyperliquid/copy')).body.trades;

  // What the page is told.
  const ov = (await call('GET', '/v1/hyperliquid/copy')).body;
  assert.equal(ov.enabled, true);
  assert.match(ov.enforced_by_rektbull, /not onchain/);
  assert.match(ov.most_you_can_lose, /margin in your Hyperliquid account/);
  assert.match(ov.not_advice, /doesn't vet traders/);
  assert.deepEqual([ov.fee.decided.open_rate, ov.fee.decided.profit_close_rate], ['0.05%', '0.1%']);

  // A trader's results, by Hyperliquid's own figures, with their source.
  const prof = (await call('GET', `/v1/hyperliquid/copy/traders/${leader}`)).body;
  assert.equal(prof.results.month.pnl_usd, 4200.5); assert.equal(prof.results.all_time.pnl_usd, -310); assert.equal(prof.results.day, null);
  assert.equal(prof.positions[0].coin, 'ETH'); assert.equal(prof.source, hl.SOURCE);

  // Copy trading runs on automatic trading: a grant first, then RektBull's fees on decided trades approved.
  assert.equal((await call('POST', '/v1/hyperliquid/copy/follows', FOLLOW)).body.error, 'no_grant');
  assert.equal((await call('POST', '/v1/hyperliquid/auto/grant', { approval: await grantApproval(), limits: LIMITS })).status, 201);
  const unpaid = await call('POST', '/v1/hyperliquid/copy/follows', FOLLOW);
  assert.equal(unpaid.status, 409); assert.equal(unpaid.body.error, 'fee_not_approved');
  assert.match(unpaid.body.message, /0\.05% to open, 0\.1% to close at a profit, nothing at a loss/);
  assert.deepEqual(unpaid.body.fee, { builder: env.hlBuilderAddress, tenths_bps: 100, rate: '0.1%' }, 'the page is told what to ask the wallet for');
  builderApproved = 100;
  // The settings.
  assert.equal((await call('POST', '/v1/hyperliquid/copy/follows', { ...FOLLOW, leader: wallet })).status, 400, 'not your own account');
  assert.equal((await call('POST', '/v1/hyperliquid/copy/follows', { ...FOLLOW, trade_usd: 300 })).status, 400, 'over the grant\'s per-trade amount');
  assert.equal((await call('POST', '/v1/hyperliquid/copy/follows', { ...FOLLOW, max_leverage: 6 })).status, 400, 'over the grant\'s leverage');
  assert.equal((await call('POST', '/v1/hyperliquid/copy/follows', { ...FOLLOW, stop_loss_pct: 40 })).status, 400, 'a stop past liquidation');
  assert.equal((await call('POST', '/v1/hyperliquid/copy/follows', { ...FOLLOW, stop_loss_pct: undefined })).status, 400, 'every copy has a stop-loss');
  // Followed: what the trader holds already isn't copied.
  const f = await call('POST', '/v1/hyperliquid/copy/follows', FOLLOW);
  assert.equal(f.status, 201, JSON.stringify(f.body));
  assert.deepEqual(f.body.not_copied, ['long ETH']);
  assert.equal((await call('POST', '/v1/hyperliquid/copy/follows', FOLLOW)).body.error, 'already_following');
  await copy.watch(leader);
  assert.equal((await trades()).length, 0);

  // The trader opens a BTC long at 10x: the follower's copy is $100 at 3x (their cap), with their 5% stop,
  // a trade RektBull decides: 0.05% to open, the stop nothing.
  held[leader] = [pos('ETH', 2, 1800), pos('BTC', 0.5, 65300, 10)];
  await copy.watch(leader);
  let [tr] = await trades();
  assert.equal(tr.status, 'open'); assert.equal(tr.coin, 'BTC'); assert.equal(tr.side, 'long');
  let { rows: [intent] } = await db.query(`SELECT * FROM hl_auto_intents WHERE id = $1`, [tr.open_intent]);
  assert.deepEqual([intent.source, intent.side, Number(intent.size_usd), intent.leverage, Number(intent.stop_loss_pct), intent.follow_id], ['agent', 'long', 100, 3, 5, f.body.follow.id]);
  let n = sent.length;
  await auto.tick();
  const [lev, open, sl] = sent.slice(n);
  assert.deepEqual([lev.action.type, lev.action.leverage, lev.action.isCross], ['updateLeverage', 3, false]);
  assert.deepEqual(open.action.builder, { b: env.hlBuilderAddress, f: 50 });
  assert.equal(sl.action.orders[0].t.trigger.tpsl, 'sl'); assert.equal(sl.action.builder, undefined);
  held[wallet] = [pos('BTC', 0.0015, 65400, 3, '2.5')];

  // Seen again unchanged: nothing more.
  await copy.watch(leader);
  assert.equal((await trades()).length, 1);
  // A read that fails is never taken as a close.
  leaderDown = true;
  await copy.watch(leader);
  leaderDown = false;
  assert.equal((await trades())[0].status, 'open');
  assert.match((await db.query(`SELECT error FROM hl_copy_leaders WHERE leader = $1`, [leader])).rows[0].error, /didn't answer/);

  // The trader closes BTC: the copy is closed, at a profit, so 0.10%.
  held[leader] = [pos('ETH', 2, 1800)];
  await copy.watch(leader);
  [tr] = await trades();
  assert.equal(tr.status, 'closed'); assert.match(tr.reason, /trader closed/);
  n = sent.length;
  await auto.tick();
  assert.equal(sent.length, n + 1);
  assert.equal(sent.at(-1).action.orders[0].r, true);
  assert.deepEqual(sent.at(-1).action.builder, { b: env.hlBuilderAddress, f: 100 }, 'closed at a profit');
  held[wallet] = [];

  // The price has run past the limit since the trader's entry: not chased.
  held[leader] = [pos('ETH', 2, 1800), pos('SOL', 100, 70)]; // SOL's mark in the fixture is 71.919, 2.7% higher
  await copy.watch(leader);
  [tr] = await trades();
  assert.equal(tr.status, 'skipped'); assert.match(tr.reason, /moved 2\.74% against you since the trader's entry \(70\), more than 1%/);
  // A market where the follower holds a position copying didn't open: left alone.
  held[wallet] = [pos('ETH', 0.1, 1830)];
  held[leader] = [pos('ETH', -2, 1832.5), pos('SOL', 100, 70)];
  await copy.watch(leader);
  [tr] = await trades();
  assert.equal(tr.coin, 'ETH'); assert.equal(tr.status, 'skipped'); assert.match(tr.reason, /You hold a long in ETH that copying didn't open/);
  held[wallet] = [];

  // A flip: the trader's BTC long becomes a short. The copy's long is closed, then a short opened.
  held[leader] = [pos('BTC', 0.5, 65360, 2)];
  await copy.watch(leader);
  await auto.tick();
  held[wallet] = [pos('BTC', 0.0015, 65400, 2, '-1')];
  held[leader] = [pos('BTC', -0.5, 65370, 2)];
  await copy.watch(leader);
  const [short, long] = await trades();
  assert.deepEqual([long.side, long.status, short.side, short.status], ['long', 'closed', 'short', 'open']);
  n = sent.length;
  await auto.tick();
  const [closeLong] = sent.slice(n);
  assert.equal(closeLong.action.orders[0].r, true);
  assert.equal(closeLong.action.builder, undefined, 'closed at a loss: nothing');

  // Paused by RektBull: no new copies, but the trader's closes still go through.
  const services = require('../src/admin/services');
  await services.set('perps_copy', 'paused', { wallet: '0xadmin', reason: 'test' });
  held[wallet] = [pos('BTC', -0.0015, 65400, 2, '0')];
  held[leader] = [pos('BTC', -0.5, 65370, 2), pos('ETH', 1, 1832)];
  await copy.watch(leader);
  [tr] = await trades();
  assert.equal(tr.coin, 'ETH'); assert.match(tr.reason, /paused by RektBull/);
  assert.equal((await call('POST', '/v1/hyperliquid/copy/follows', { ...FOLLOW, leader: '0x' + '77'.repeat(20) })).status, 503, 'no new follows while paused');
  await services.set('perps_copy', 'on', { wallet: '0xadmin', reason: 'test' });

  // Stopping, and closing the copies: the user's own decision, so their own 0.01%.
  const stopped = await call('POST', `/v1/hyperliquid/copy/follows/${f.body.follow.id}/stop`, { close_positions: true });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.follow.status, 'stopped'); assert.equal(stopped.body.closes.length, 1);
  assert.equal(stopped.body.closes[0].intent.source, 'user');
  n = sent.length;
  await auto.tick();
  assert.deepEqual(sent.at(-1).action.builder, { b: env.hlBuilderAddress, f: 10 });
  assert.equal(sent.length, n + 1);
  // A stopped copy copies nothing more.
  held[leader] = [pos('BTC', -0.5, 65370, 2), pos('ETH', 1, 1832), pos('SOL', 10, 71.9)];
  const before = (await trades()).length;
  await copy.watch(leader);
  assert.equal((await trades()).length, before);

  // Copying ends with automatic trading.
  const f2 = await call('POST', '/v1/hyperliquid/copy/follows', FOLLOW);
  assert.equal(f2.status, 201, JSON.stringify(f2.body));
  await call('POST', '/v1/hyperliquid/auto/revoke', {});
  await copy.tick();
  const { body: after } = await call('GET', '/v1/hyperliquid/copy');
  assert.equal(after.follows[0].status, 'stopped'); assert.match(after.follows[0].stop_reason, /automatic-trading approval ended/);
});

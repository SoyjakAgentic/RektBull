/**
 * Hyperliquid proposals, phase 1 (src/hyperliquid/protect.js): the rules for
 * protecting a position, the proposal fee only on a live proposal's
 * reduce-only orders, the market alerts, and Perps Guard's alerts. Hyperliquid
 * is faked with plain answers in its own format.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { JWT_SECRET: 'test-secret', NEW_WALLET_CHECK_CHAINS: '', PUBLIC_URL: 'https://rektbull.test', HL_ENABLED: 'true', HL_NETWORK: 'testnet', DATABASE_URL: DB || '' });
require('../src/providers/llama').protocols = async () => [];
const H = require('../public/hl-core.js');
const hl = require('../src/providers/hyperliquid');
const env = require('../src/config/env');
const protect = require('../src/hyperliquid/protect');

const BUILDER = '0x' + 'b1'.repeat(20);
const user = ethers.Wallet.createRandom();
const agent = ethers.Wallet.createRandom();
const wallet = user.address.toLowerCase();

// Two deep markets and a thin one. BTC: funding 0.01% an hour (87.6% a year). ETH: shorts pay 0.025% an hour, mark 1% under the oracle.
const META = [
  { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }, { name: 'THIN', szDecimals: 0, maxLeverage: 3 }] },
  [
    { markPx: '60000', oraclePx: '60000', midPx: '60000', prevDayPx: '60000', funding: '0.0001', openInterest: '1000', dayNtlVlm: '1000000000' },
    { markPx: '3000', oraclePx: '3030', midPx: '3000', prevDayPx: '3000', funding: '-0.00025', openInterest: '20000', dayNtlVlm: '500000000' },
    { markPx: '1', oraclePx: '1.5', midPx: '1', prevDayPx: '1', funding: '0.01', openInterest: '100', dayNtlVlm: '1000' },
  ],
];
// A BTC long 4% from liquidation with no stop-loss; an ETH short far from it, with a stop on the book, paying funding.
const STATE = {
  marginSummary: { accountValue: '20000', totalMarginUsed: '5600', totalNtlPos: '66000' }, withdrawable: '14000', crossMaintenanceMarginUsed: '1000', time: Date.now(),
  assetPositions: [
    { position: { coin: 'BTC', szi: '1.0', entryPx: '61000', positionValue: '60000', unrealizedPnl: '-1000', returnOnEquity: '-0.2', liquidationPx: '57600', marginUsed: '5000', leverage: { type: 'cross', value: 12 }, maxLeverage: 40, cumFunding: { sinceOpen: '12.5' } } },
    { position: { coin: 'ETH', szi: '-2.0', entryPx: '3100', positionValue: '6000', unrealizedPnl: '200', returnOnEquity: '0.33', liquidationPx: '4000', marginUsed: '600', leverage: { type: 'isolated', value: 10 }, maxLeverage: 25, cumFunding: { sinceOpen: '-3' } } },
  ],
};
const ORDERS = [{ coin: 'ETH', side: 'B', limitPx: '3500', sz: '2', origSz: '2', oid: 5, orderType: 'Stop Market', reduceOnly: true, isTrigger: true, triggerPx: '3300', triggerCondition: 'Price above 3300', isPositionTpsl: false, tif: null, timestamp: Date.now() }];
// Flat hours: each moves 0.5% high to low.
const candles = c => Array.from({ length: 24 }, (_, i) => ({ t: Date.now() - (24 - i) * 3600000, o: String(c), c: String(c), h: String(c * 1.0025), l: String(c * 0.9975), v: '1' }));

function fake({ exchange = [] } = {}) {
  hl._reset();
  hl.setTransport(async (p, body) => {
    if (p === '/exchange') { exchange.push(body); return { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 900 } }] } } }; }
    if (body.type === 'metaAndAssetCtxs') return META;
    if (body.type === 'clearinghouseState') return STATE;
    if (body.type === 'frontendOpenOrders') return ORDERS;
    if (body.type === 'candleSnapshot') return candles(body.req.coin === 'BTC' ? 60000 : 3000);
    if (body.type === 'extraAgents') return [];
    if (body.type === 'maxBuilderFee') return 50;
    throw new Error(`unexpected ${body.type}`);
  });
}

test('the rules: a stop-loss before liquidation, reducing by half when it\'s near, and funding as facts', async () => {
  fake();
  const r = await protect.review(wallet);
  assert.deepEqual(r.not_checked, []);
  assert.equal(r.positions, 2);
  assert.deepEqual(r.proposals.map(p => [p.coin, p.kind, p.severity]), [['BTC', 'liq_near', 'high'], ['BTC', 'no_stop', 'high'], ['BTC', 'funding_cost', 'medium'], ['ETH', 'funding_cost', 'medium']],
    'ETH has a stop before its liquidation price and is 33% from it: only its funding is worth a look');

  const [near, stop, btcFunding, ethFunding] = r.proposals;
  assert.equal(near.title, 'BTC long: liquidation is 4% away');
  assert.match(near.why, /closer than 5%|a typical day's range/);
  assert.deepEqual(near.action.orders, [{ a: 0, b: false, p: '59400', s: '0.5', r: true, t: { limit: { tif: 'Ioc' } } }], 'reduce by half: a reduce-only sell, at no worse than 1% under the mark');
  assert.ok(near.facts.some(f => f.text === 'A typical hour moves 0.5%; the last 24 hours ranged 0.5%' && /candles/.test(f.source)));

  // 3 typical hourly moves (1.5%) is inside 60% of the way to liquidation (2.4%): the stop goes at 59,100.
  assert.deepEqual(stop.action.orders, [{ a: 0, b: false, p: '53190', s: '1', r: true, t: { trigger: { isMarket: true, triggerPx: '59100', tpsl: 'sl' } } }]);
  assert.equal(stop.action.label, 'Add a stop-loss at 59100');
  assert.match(stop.action.does, /Placed 3 typical hourly moves \(1\.5%\)\. Reduce only/);
  assert.ok(stop.facts.some(f => f.text === 'At 59100 the position would be down $1,900.00 on its entry, $900.00 worse than now (before fees)'));
  assert.ok(r.proposals.every(p => !p.action || p.action.orders.every(o => o.r === true)), 'every fix is reduce-only');

  assert.equal(btcFunding.title, 'BTC long: funding costs about $144.00 a day');
  assert.equal(btcFunding.action, null, 'funding is facts only');
  assert.ok(btcFunding.facts.some(f => /87\.6% a year\) on a \$60,000\.00 position: about \$144\.00 a day, 2\.88% of its margin/.test(f.text)));
  assert.equal(ethFunding.why, 'Shorts pay longs 219% a year at the current rate.');

  // Close to liquidation, the stop goes 60% of the way there instead; within half the threshold it's critical.
  const m = (await require('../src/hyperliquid/markets').markets()).find(x => x.coin === 'BTC');
  const p = { coin: 'BTC', side: 'long', size: 1, entry_px: 61000, value_usd: 60000, liquidation_px: 59400, margin_used_usd: 5000, leverage: 40, margin_mode: 'cross', funding_since_open_usd: null };
  const close = protect.forPosition(p, m, { hourly_move_pct: 0.5, day_range_pct: 0.5, source: 'x' }, []);
  assert.deepEqual(close.filter(x => x.kind !== 'funding_cost').map(x => [x.kind, x.severity]), [['liq_near', 'critical'], ['no_stop', 'high']]);
  assert.equal(close.find(x => x.kind === 'no_stop').action.orders[0].t.trigger.triggerPx, '59640', '1% to liquidation: the stop at 60% of the way, 0.6%');
  // A stop already past the liquidation price doesn't count.
  const useless = [{ coin: 'BTC', side: 'sell', type: 'Stop Market', trigger: true, reduce_only: true, trigger_px: 59000 }];
  assert.ok(protect.forPosition(p, m, { hourly_move_pct: 0.5, day_range_pct: 0.5, source: 'x' }, useless).some(x => x.kind === 'no_stop'));
  // No liquidation price, and no candles: the 5% fallback, and it says so.
  const safe = protect.forPosition({ ...p, liquidation_px: null }, m, { error: 'timeout' }, []);
  assert.deepEqual(safe.map(x => x.kind), ['no_stop', 'funding_cost']);
  assert.equal(safe[0].action.orders[0].t.trigger.triggerPx, '57000');
  assert.match(safe[0].action.does, /5%, as a typical move couldn't be read/);
  assert.ok(safe[0].facts.some(f => f.not_checked && /couldn't be read: timeout/.test(f.text)));
});

test('through the app: proposals saved, the proposal fee only on their orders, market alerts, Perps Guard', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  require('../src/admin/settings').reset();
  await require('../src/compliance/regions').set('hyperliquid', [], { wallet: '0xtest', reason: 'tests run from no country' });
  await require('../src/compliance/regions').set('hyperliquid_auto', [], { wallet: '0xtest', reason: 'tests run from no country' });
  const saved = { address: env.hlBuilderAddress, fee: env.hlBuilderFeeTenthsBps, enabled: env.hlEnabled };
  Object.assign(env, { hlBuilderAddress: BUILDER, hlBuilderFeeTenthsBps: 10, hlEnabled: true });
  t.after(() => Object.assign(env, { hlBuilderAddress: saved.address, hlBuilderFeeTenthsBps: saved.fee, hlEnabled: saved.enabled }));
  const exchange = [];
  fake({ exchange });

  const { issueToken } = require('../src/auth/siwe');
  const server = require('../src/app').createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [wallet]);
  const { rows: [other] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', ['0x' + '0e'.repeat(20)]);
  const call = async (method, p, body, a = acct) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${issueToken(a)}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const signed = async (action, extra = {}) => {
    const nonce = Date.now() + exchange.length;
    const expiresAfter = nonce + 30000;
    return { ...extra, action, nonce, signature: await H.signL1(agent, action, { nonce, mainnet: hl.isMainnet(), expiresAfter }), expiresAfter };
  };

  // The config names both fees; the proposals come with ids and the proposal fee.
  const cfg = (await call('GET', '/v1/hyperliquid/config')).body.builder;
  assert.deepEqual([cfg.max_fee_rate, cfg.proposal_fee_rate], ['0.01%', '0.05%']);
  const r = await call('GET', '/v1/hyperliquid/protect');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const stop = r.body.proposals.find(p => p.kind === 'no_stop');
  assert.match(stop.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(stop.fee, { tenths_bps: 50, rate: '0.05%', builder: BUILDER });
  assert.equal(r.body.proposals.find(p => p.kind === 'funding_cost').id, undefined, 'facts only: nothing to sign, nothing saved');
  const { rows } = await db.query('SELECT kind, fee_tenths_bps, asset FROM hl_proposals WHERE account_id = $1 ORDER BY kind', [acct.id]);
  assert.deepEqual(rows.map(x => [x.kind, x.fee_tenths_bps, x.asset]), [['liq_near', 50, 0], ['no_stop', 50, 0]]);

  // Acting: the stop-loss, signed by the browser's key, carrying 0.05%, with its proposal.
  const at50 = H.orderAction(stop.action.orders, { builder: { b: BUILDER, f: 50 } });
  const noProposal = await call('POST', '/v1/hyperliquid/exchange', await signed(at50));
  assert.deepEqual([noProposal.status, noProposal.body.error], [422, 'wrong_fee'], 'without its proposal, 0.05% is refused');
  const notMine = await call('POST', '/v1/hyperliquid/exchange', await signed(at50, { proposal_id: stop.id }), other);
  assert.deepEqual([notMine.status, notMine.body.error], [409, 'proposal_expired'], 'someone else\'s proposal is no proposal');
  const opening = H.orderAction([H.orderWire({ asset: 0, isBuy: true, px: '60600', sz: '0.1', tif: 'Ioc' })], { builder: { b: BUILDER, f: 50 } });
  assert.equal((await call('POST', '/v1/hyperliquid/exchange', await signed(opening, { proposal_id: stop.id }))).body.error, 'wrong_fee', 'never on an order that opens');
  assert.equal(exchange.length, 0, 'nothing refused reached Hyperliquid');
  const ok = await call('POST', '/v1/hyperliquid/exchange', await signed(at50, { proposal_id: stop.id }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(exchange[0].action.builder, { b: BUILDER, f: 50 });
  assert.equal(exchange[0].proposal_id, undefined, 'only what Hyperliquid needs is passed on');
  assert.ok((await db.query('SELECT acted_at FROM hl_proposals WHERE id = $1', [stop.id])).rows[0].acted_at);
  assert.equal((await call('POST', '/v1/hyperliquid/exchange', await signed(at50, { proposal_id: stop.id }))).status, 409, 'a proposal is used once');
  const near = r.body.proposals.find(p => p.kind === 'liq_near');
  await db.query(`UPDATE hl_proposals SET expires_at = now() - interval '1 second' WHERE id = $1`, [near.id]);
  const late = await call('POST', '/v1/hyperliquid/exchange', await signed(H.orderAction(near.action.orders, { builder: { b: BUILDER, f: 50 } }), { proposal_id: near.id }));
  assert.match(late.body.message, /expired or was already used.*10 minutes/);

  // Market alerts: the deep markets only, with an hour of snapshots for open interest.
  assert.equal(await protect.snapshot(), 2, 'BTC and ETH; the thin market is left out');
  await db.query(`INSERT INTO hl_market_snapshots (coin, at, mark_px, open_interest_usd) VALUES ('BTC', now() - interval '65 minutes', 60000, 50000000), ('ETH', now() - interval '65 minutes', 3000, 80000000)`);
  const al = (await call('GET', '/v1/hyperliquid/alerts')).body;
  assert.equal(al.markets, 2);
  assert.deepEqual(al.alerts.map(a => [a.coin, a.kind, a.severity]), [['ETH', 'funding_extreme', 'high'], ['BTC', 'oi_build', 'medium'], ['ETH', 'mark_oracle', 'medium'], ['ETH', 'oi_flush', 'medium']]);
  assert.equal(al.alerts[0].title, 'ETH: shorts pay longs 219% a year');
  assert.match(al.alerts.find(a => a.kind === 'oi_build').title, /^BTC: open interest up 20% in 6[5-6] minutes, price flat$/);
  assert.ok(al.alerts.every(a => a.source && /Hyperliquid/.test(a.source)));

  // Perps Guard: an alert per position and risk, once.
  const agents = require('../src/services/myAgents');
  await agents.update(acct.id, 'perps_guard', { enabled: true });
  const row = async () => (await db.query(`SELECT * FROM agent_settings WHERE account_id = $1 AND agent = 'perps_guard'`, [acct.id])).rows[0];
  const first = await agents.runOne(await row());
  assert.equal(first.alerts, 4);
  assert.equal(first.result.text, '2 positions checked, 4 at risk');
  const { rows: raised } = await db.query(`SELECT kind, severity, title, detail FROM monitor_alerts WHERE account_id = $1 ORDER BY id`, [acct.id]);
  assert.deepEqual(raised.map(a => [a.kind, a.severity, a.title]).slice(0, 2), [['perps_guard', 'high', 'BTC long: liquidation is 4% away'], ['perps_guard', 'high', 'BTC long: no stop-loss before liquidation']]);
  assert.equal(raised[1].detail.fix, 'Add a stop-loss at 59100');
  const m = require('../src/alerts/format').message({ ...raised[1], wallet });
  assert.equal(m.action, 'Review the fix');
  assert.match(m.url, /\/perps#protect-card$/);
  assert.match(m.text, /Nothing on the book would close this position before it's liquidated\. \(RektBull's rules/);
  assert.equal((await agents.runOne(await row())).alerts, 0, 'the same risks aren\'t sent twice');
  // It has its own job: the shared agents job leaves it alone; the fast one runs it, and sets the next run 5 minutes on.
  await db.query(`UPDATE agent_settings SET next_run_at = now() - interval '1 minute' WHERE agent = 'perps_guard'`);
  assert.equal(await agents.tick(), 0);
  assert.equal(await agents.tick({ fast: true }), 1);
  const next = (await row()).next_run_at - Date.now();
  assert.ok(next > 4 * 60000 && next <= 5 * 60000, `next run in about 5 minutes (${Math.round(next / 1000)}s)`);
});

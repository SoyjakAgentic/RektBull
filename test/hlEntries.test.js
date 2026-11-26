/**
 * Hyperliquid entry proposals (src/hyperliquid/entries.js): the three rules on
 * hourly candles, the bracket, scoring in R net of costs from 15-minute
 * candles, the public scorecard in shadow, and, once offered, a bracket sized
 * for one account whose exact orders alone may carry the proposal fee.
 * Hyperliquid is faked with answers in its own format.
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
const entries = require('../src/hyperliquid/entries');

const BUILDER = '0x' + 'b1'.repeat(20);
const HOUR = 3600000;
const user = ethers.Wallet.createRandom();
const agent = ethers.Wallet.createRandom();
const wallet = user.address.toLowerCase();

/** 25 closed hourly candles ending just before `end`: 24 flat (99 to 101, volume 100), then `last`. */
const hours = (end, last) => [
  ...Array.from({ length: 24 }, (_, i) => ({ t: end - (25 - i) * HOUR, T: end - (24 - i) * HOUR - 1, o: 100, c: 100, h: 101, l: 99, v: 100 })),
  { t: end - HOUR, T: end - 1, o: 100, ...last },
];
const market = (o = {}) => ({ coin: 'BTC', asset: 0, mark_px: 103, sz_decimals: 5, max_leverage: 40, funding_hourly_pct: 0.001, open_interest_usd: 60e6, day_volume_usd: 1e9, auto: true, ...o });

test('the rules: a breakout on volume, a funding fade, a flush reversal; each a bracket at 1R and 2R', () => {
  const end = Date.now();
  const [b] = entries.check(market(), hours(end, { c: 103, h: 103.5, l: 100.5, v: 200 }), null);
  assert.deepEqual([b.rule, b.side, b.hourly_move_pct], ['breakout', 'long', 2]);
  assert.equal(b.stop_pct, 4, '2 typical hourly moves (2% each)');
  assert.deepEqual([Math.round(b.stop_px * 100) / 100, Math.round(b.tp_px * 100) / 100], [98.88, 111.24], 'stop 4% under the entry, take-profit 8% over');
  assert.match(b.facts[0].text, /closed at 103, above the previous 24 hours' high of 101/);
  assert.equal(entries.check(market(), hours(end, { c: 103, h: 103.5, l: 100.5, v: 120 }), null).length, 0, 'no breakout on thin volume');

  // Longs paying 175% a year, and the price down over 4 hours: fade them.
  const fade = entries.check(market({ funding_hourly_pct: 0.02, mark_px: 98 }), hours(end, { c: 98, h: 100, l: 97.8, v: 100 }), null);
  assert.deepEqual(fade.map(s => [s.rule, s.side]), [['funding_fade', 'short']]);
  assert.match(fade[0].facts[0].text, /^Longs pay shorts 175\.2% a year/);
  assert.equal(entries.check(market({ funding_hourly_pct: 0.02 }), hours(end, { c: 100.5, h: 100.8, l: 99.5, v: 100 }), null).length, 0, 'the crowd still winning: no fade');

  // Open interest down 15% in an hour on a 4% drop: against the move.
  const flush = entries.check(market({ mark_px: 96, open_interest_usd: 85e6 }), hours(end, { c: 96, h: 100, l: 95.5, v: 100 }), { oi: 100e6, mark_px: 100 });
  assert.deepEqual(flush.map(s => [s.rule, s.side]), [['flush_reversal', 'long']]);

  // The stop is kept between 0.5% and 5%.
  assert.equal(entries.bracket('long', 100, 0.1).stop_pct, 0.5);
  assert.equal(entries.bracket('short', 100, 9).stop_pct, 5);
  assert.equal(entries.bracket('short', 100, 9).tp_px, 90);
});

test('scoring: the take-profit or the stop, whichever first (the stop when one candle reaches both), net of costs', () => {
  const saved = { a: env.hlBuilderAddress, f: env.hlBuilderFeeTenthsBps };
  Object.assign(env, { hlBuilderAddress: BUILDER, hlBuilderFeeTenthsBps: 10 });
  try {
    const t0 = Date.parse('2026-11-20T10:00:00Z');
    const s = { side: 'long', entry_px: 100, stop_px: 96, tp_px: 108, stop_pct: 4, funding_hourly_pct: 0, created_at: new Date(t0).toISOString() };
    const bar = (i, l, h, c = 100) => ({ t: t0 + i * 900000, T: t0 + (i + 1) * 900000 - 1, o: 100, h, l, c, v: 1 });
    // Costs: Hyperliquid's 0.045% and RektBull's 0.05%, both ways = 0.19% of a 4% stop = 0.0475R.
    assert.equal(Math.round(entries.costsR(s, 0) * 10000) / 10000, 0.0475);
    const tp = entries.walk(s, [bar(0, 99, 102), bar(1, 99, 104), bar(2, 101, 108.5)]);
    assert.deepEqual([tp.status, tp.exit_px, tp.r_final], ['tp', 108, 1.95]);
    const both = entries.walk(s, [bar(0, 95, 109)]);
    assert.deepEqual([both.status, both.r_final], ['stop', -1.05], 'one candle reached both: counted as the stop');
    // A candle that opened before the entry doesn't count, whatever it reached.
    const early = entries.walk(s, [{ t: t0 - 600000, T: t0 + 299999, o: 100, h: 110, l: 90, c: 100, v: 1 }, bar(1, 99.5, 100.5)]);
    assert.equal(early, null, 'nothing recorded yet');
    // Neither within 24 hours: closed at the 24-hour candle, with 1 and 4 hours marked on the way.
    const flat = Array.from({ length: 96 }, (_, i) => bar(i, 99, 101, i < 4 ? 101 : i < 16 ? 102 : 99));
    const exp = entries.walk(s, flat);
    assert.deepEqual([exp.status, exp.r_1h, exp.r_4h, exp.r_24h, exp.r_final], ['expired', 0.2, 0.45, -0.3, -0.3]);
    // Funding against a long adds to its cost: 0.01% an hour for 24 hours is 0.24% more, 0.06R.
    assert.equal(Math.round(entries.costsR({ ...s, funding_hourly_pct: 0.01 }, 24) * 10000) / 10000, 0.1075);
  } finally { Object.assign(env, { hlBuilderAddress: saved.a, hlBuilderFeeTenthsBps: saved.f }); }
});

test('through the app: shadow, then offered; sized for the account; only the exact orders carry the fee', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  const settings = require('../src/admin/settings');
  settings.reset();
  await require('../src/compliance/regions').set('hyperliquid', [], { wallet: '0xtest', reason: 'tests run from no country' });
  await require('../src/compliance/regions').set('hyperliquid_auto', [], { wallet: '0xtest', reason: 'tests run from no country' });
  const saved = { a: env.hlBuilderAddress, f: env.hlBuilderFeeTenthsBps };
  Object.assign(env, { hlBuilderAddress: BUILDER, hlBuilderFeeTenthsBps: 10 });
  t.after(() => Object.assign(env, { hlBuilderAddress: saved.a, hlBuilderFeeTenthsBps: saved.f }));

  // Hyperliquid: BTC deep and breaking out; an empty account worth $20,000.
  const now = Date.now();
  let mark = 103;
  let bars15 = [];
  const exchange = [];
  hl._reset();
  hl.setTransport(async (p, body) => {
    if (p === '/exchange') { exchange.push(body); return { status: 'ok', response: { type: 'order', data: { statuses: (body.action.orders || [{}]).map(() => ({ resting: { oid: 7 } })) } } }; }
    if (body.type === 'metaAndAssetCtxs') return [{ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] }, [{ markPx: String(mark), oraclePx: String(mark), midPx: String(mark), prevDayPx: '100', funding: '0.00001', openInterest: '600000', dayNtlVlm: '1000000000' }]];
    if (body.type === 'candleSnapshot') return body.req.interval === '1h' ? hours(now, { c: 103, h: 103.5, l: 100.5, v: 200 }).map(c => ({ ...c, t: c.t, T: c.T, o: String(c.o), c: String(c.c), h: String(c.h), l: String(c.l), v: String(c.v) })) : bars15;
    if (body.type === 'clearinghouseState') return { marginSummary: { accountValue: '20000', totalMarginUsed: '0', totalNtlPos: '0' }, withdrawable: '20000', crossMaintenanceMarginUsed: '0', assetPositions: [], time: now };
    if (body.type === 'frontendOpenOrders') return [];
    if (body.type === 'extraAgents') return [];
    if (body.type === 'maxBuilderFee') return 50;
    throw new Error(`unexpected ${body.type}`);
  });

  // Off by default: nothing runs.
  assert.deepEqual(await entries.tick(now), { off: true });
  // Shadow: the rules run once for the hour; the signal is logged, not offered.
  await settings.set('forecasts', { hyperliquid: true }, { wallet: '0xadmin', action: 'forecasts', reason: 'shadow' });
  assert.equal(await entries.run(now), 1);
  assert.equal(await entries.run(now), null, 'once per hourly candle');
  const { rows: [sig] } = await db.query('SELECT * FROM hl_signals');
  assert.deepEqual([sig.coin, sig.rule, sig.side, sig.offered, Number(sig.stop_pct)], ['BTC', 'breakout', 'long', false, 4]);

  const { issueToken } = require('../src/auth/siwe');
  const server = require('../src/app').createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [wallet]);
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${issueToken(acct)}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  let pub = (await call('GET', '/v1/hyperliquid/entries')).body;
  assert.deepEqual([pub.mode, pub.overall.signals, pub.open.length], ['shadow', 1, 0], 'in shadow: in the scorecard, open to nobody');
  assert.equal((await call('GET', '/v1/forecasts/track-record?venue=hyperliquid')).status, 200, 'the track-record route no longer asks for a module that doesn\'t exist');
  assert.equal((await call('POST', `/v1/hyperliquid/entries/${sig.id}/bracket`)).body.error, 'not_offered');

  // Scored: the take-profit (111.24) is reached in the second 15-minute candle after the entry.
  const t0 = new Date(sig.created_at).getTime();
  bars15 = [0, 1].map(i => ({ t: t0 + i * 900000 + 1000, T: t0 + (i + 1) * 900000, o: '103', c: '104', h: i ? '112' : '104', l: '102', v: '1' }));
  assert.equal(await entries.score(Date.now() + 3 * 900000), 1);
  pub = (await call('GET', '/v1/hyperliquid/entries')).body;
  assert.deepEqual([pub.overall.scored, pub.overall.take_profit, pub.by_rule[0].avg_r, pub.latest[0].status], [1, 1, 1.95, 'tp']);

  // Offered: a new signal, made while offered; the user must ask for them first.
  await settings.set('forecasts', { hyperliquid: true, hyperliquid_proposals: true }, { wallet: '0xadmin', action: 'forecasts', reason: 'offer' });
  const { rows: [live] } = await db.query(`INSERT INTO hl_signals (coin, asset, rule, side, entry_px, stop_px, tp_px, stop_pct, funding_hourly_pct, facts, offered)
    VALUES ('BTC', 0, 'breakout', 'long', 103, 98.88, 111.24, 4, 0.001, '[]', true) RETURNING id`);
  assert.equal((await call('POST', `/v1/hyperliquid/entries/${live.id}/bracket`)).body.error, 'not_opted_in');
  await call('PUT', '/v1/ai/proposals/settings', { hyperliquid: true });
  pub = (await call('GET', '/v1/hyperliquid/entries')).body;
  assert.deepEqual([pub.mode, pub.open.map(s => s.id)], ['offered', [live.id]]);

  // Sized for the account: 1% of $20,000 at a 4% stop is $5,000; 10x isolated (12x would keep liquidation past the stop; capped at 10x).
  const b = (await call('POST', `/v1/hyperliquid/entries/${live.id}/bracket`)).body;
  assert.equal(b.id.length, 36, JSON.stringify(b));
  assert.deepEqual([b.side, b.size, b.leverage, b.margin_mode, b.notional_usd, b.risk_usd, b.margin_usd], ['long', '48.54368', 10, 'isolated', 5000, 200, 500]);
  assert.deepEqual(b.action.orders.map(o => [o.b, o.r, o.t.limit ? 'ioc' : o.t.trigger.tpsl]), [[true, false, 'ioc'], [false, true, 'sl'], [false, true, 'tp']]);
  assert.deepEqual(b.leverage_action, { type: 'updateLeverage', asset: 0, isCross: false, leverage: 10 });
  assert.deepEqual(b.fee, { tenths_bps: 50, rate: '0.05%', builder: BUILDER });
  assert.match(b.says, /At the stop you'd lose about \$200 \(1% of your account\) plus fees; the most you can lose is the margin/);

  // Only the exact orders carry the fee, and only once.
  const sign = async (action, extra = {}) => {
    const nonce = Date.now() + exchange.length + Math.floor(Math.random() * 1000);
    const expiresAfter = nonce + 30000;
    return { ...extra, action, nonce, signature: await H.signL1(agent, action, { nonce, mainnet: false, expiresAfter }), expiresAfter };
  };
  const bigger = H.orderAction([{ ...b.action.orders[0], s: '60' }, ...b.action.orders.slice(1)], { grouping: 'normalTpsl', builder: { b: BUILDER, f: 50 } });
  assert.equal((await call('POST', '/v1/hyperliquid/exchange', await sign(bigger, { proposal_id: b.id }))).body.error, 'wrong_fee', 'a bigger entry than proposed: refused');
  const noStop = H.orderAction([b.action.orders[0]], { grouping: 'normalTpsl', builder: { b: BUILDER, f: 50 } });
  assert.equal((await call('POST', '/v1/hyperliquid/exchange', await sign(noStop, { proposal_id: b.id }))).body.error, 'wrong_fee', 'the entry without its stop: refused');
  assert.equal(exchange.length, 0);
  assert.equal((await call('POST', '/v1/hyperliquid/exchange', await sign(b.leverage_action))).status, 200, 'the leverage change first');
  const exact = H.orderAction(b.action.orders.map(o => ({ ...o, c: H.cloid() })), { grouping: 'normalTpsl', builder: { b: BUILDER, f: 50 } });
  const ok = await call('POST', '/v1/hyperliquid/exchange', await sign(exact, { proposal_id: b.id }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(exchange.at(-1).action.builder, { b: BUILDER, f: 50 });
  assert.equal((await call('POST', '/v1/hyperliquid/exchange', await sign(exact, { proposal_id: b.id }))).status, 409, 'used once');

  // The price moved past the band: no bracket.
  mark = 104;
  assert.equal((await call('POST', `/v1/hyperliquid/entries/${live.id}/bracket`)).body.error, 'price_moved');
  // A region block refuses it: it opens a position.
  await require('../src/compliance/regions').set('hyperliquid', ['ZZ'], { wallet: '0xtest', reason: 'test' });
  mark = 103;
  const blocked = await fetch(`${base}/v1/hyperliquid/entries/${live.id}/bracket`, { method: 'POST', headers: { authorization: `Bearer ${issueToken(acct)}`, 'x-test-country': 'ZZ' } });
  assert.equal(blocked.status, 451);
});

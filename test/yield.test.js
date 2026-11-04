/**
 * Yield without a chain: Aave's configuration word, every rule a move must
 * pass, what a move request must say, the fee in the catalog, and (with a
 * database) what the risk watcher calls a warning. The whole flow, on the
 * real venues, is test/yield.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const rates = require('../src/yield/rates');
const rules = require('../src/yield/rules');
const proposals = require('../src/yield/proposals');
const catalog = require('../src/payments/catalog');

const rate = (apy, extra = {}) => ({ apy_pct: apy, utilization_pct: 80, supply_open: true, deposit_room: null, flags: {}, ...extra });

test('Aave\'s configuration word: active, frozen, paused and the supply cap', () => {
  const word = (1n << 56n) | (1n << 57n) | (123n << 116n);
  assert.deepEqual(rates.aaveFlags(word), { active: true, frozen: true, paused: false, supplyCap: 123n });
  assert.equal(rates.aaveFlags(1n << 60n).paused, true);
});

test('a rate read: Spark on an L2 from its own chain, retried after a rate limit, never cached when it fails, and the failure says why', async t => {
  const axios = require('axios');
  const { ethers } = require('ethers');
  const env = require('../src/config/env');
  const cache = require('../src/lib/cache');
  const usage = require('../src/providers/usage');
  const { rpcUrls } = require('../src/providers/chains');
  const venues = require('../src/yield/venues');
  const saved = { post: axios.post, delays: rates.READ_RETRY.delaysMs, db: env.databaseUrl, eth: process.env.RPC_URLS_ETHEREUM, base: process.env.RPC_URLS_BASE };
  t.after(() => {
    axios.post = saved.post; rates.READ_RETRY.delaysMs = saved.delays; env.databaseUrl = saved.db;
    for (const [k, v] of [['RPC_URLS_ETHEREUM', saved.eth], ['RPC_URLS_BASE', saved.base]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  delete process.env.RPC_URLS_ETHEREUM; delete process.env.RPC_URLS_BASE; // each chain's public endpoint only
  env.databaseUrl = ''; // the in-process cache only
  rates.READ_RETRY.delaysMs = [0, 0];
  const [ETH] = rpcUrls('ethereum'); const [BASE] = rpcUrls('base');
  const day = new Date().toISOString().slice(0, 10);
  const callsTo = url => () => usage._counts.get(`rpc:${new URL(url).hostname}|${day}`) || 0;
  const ethCalls = callsTo(ETH); const baseCalls = callsTo(BASE);

  // Multicall3's aggregate3, answered with one uint256 per call (every Spark read returns one).
  const MC = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
  const word = x => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [x]);
  const SSR = 1000000001243680656318820312n; // about 4% a year, per second in ray
  const asked = []; // the first call of each aggregate3: where the rate came from
  const answer = (data, ok = true) => {
    const [calls] = MC.decodeFunctionData('aggregate3', data);
    asked.push({ target: calls[0].target.toLowerCase(), selector: calls[0].callData.slice(0, 10) });
    return { data: { jsonrpc: '2.0', id: 1, result: MC.encodeFunctionResult('aggregate3', [calls.map(() => [ok, ok ? word(SSR) : '0x'])]) } };
  };
  const limited = () => Promise.reject(Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } }));
  let next = []; // what the endpoint does next, one entry per call; then it answers
  axios.post = async (url, body) => {
    if (url !== BASE && url !== ETH) throw new Error(`unexpected RPC ${url}`);
    const step = next.shift();
    return step ? step(body) : answer(body.params[0].data);
  };
  const spark = venues.venue('spark-susdc', 'base');
  const KEY = 'yield:rate:spark-susdc:base:USDC';
  const read = (v = spark) => { cache._memory.delete(`yield:rate:spark-susdc:${v.chain}:USDC`); return rates.venueRate(v, 'USDC', { crossCheck: false }); };

  // Base's rate comes from Sky's SSR oracle on Base, in one call to Base: Ethereum isn't asked.
  let eth0 = ethCalls(); let before = baseCalls();
  let r = await read();
  assert.equal(r.error, undefined, r.error);
  assert.ok(r.apy_pct > 3 && r.apy_pct < 5, String(r.apy_pct));
  assert.deepEqual(asked.at(-1), { target: venues.SPARK_RATE_PROVIDER.base, selector: rates.I.ssrOracle.getFunction('getSSR').selector });
  assert.equal(baseCalls() - before, 1);
  assert.equal(ethCalls() - eth0, 0, 'an L2 rate doesn\'t wait on Ethereum');
  // Ethereum's own vault still gives its ssr().
  r = await read(venues.venue('spark-susdc', 'ethereum'));
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(asked.at(-1), { target: venues.venue('spark-susdc', 'ethereum').vault, selector: rates.I.spark.getFunction('ssr').selector });

  // Rate-limited once: asked again, counted both times, read.
  next = [limited];
  before = baseCalls();
  r = await read();
  assert.equal(r.error, undefined, r.error);
  assert.ok(r.apy_pct > 3);
  assert.equal(baseCalls() - before, 2, 'both tries went through usage.track()');

  // Rate-limited every time: three tries, then the reason.
  next = [limited, limited, limited];
  before = baseCalls();
  r = await read();
  assert.equal(r.apy_pct, null);
  assert.equal(r.supply_open, false);
  assert.equal(r.error, 'eth_call on base: every endpoint failed (Request failed with status code 429) (tried 3 times)');
  assert.equal(baseCalls() - before, 3);
  assert.equal(cache._memGet(KEY), undefined, 'a failed read isn\'t cached');
  // ...so the next request reads again, and gets the rate once the endpoint answers.
  const again = await rates.venueRate(spark, 'USDC', { crossCheck: false });
  assert.equal(again.error, undefined, again.error);
  assert.ok(again.apy_pct > 3);
  assert.ok(cache._memGet(KEY), 'a good read is cached');

  // The oracle answered but couldn't give the rate: not a passing failure, so asked once, and named.
  next = [body => Promise.resolve(answer(body.params[0].data, false))];
  before = baseCalls();
  r = await read();
  assert.equal(r.apy_pct, null);
  assert.equal(r.error, 'the Sky Savings Rate couldn\'t be read from Sky\'s SSR oracle on Base');
  assert.equal(baseCalls() - before, 1);
});

test('rules: each one refuses with its reason and figures; a move that passes says why', async t => {
  const table = { 'aave-v3': rate(5), 'compound-v3': rate(7), 'spark-susdc': rate(3.8) };
  const realRate = rates.venueRate; const realGas = rules.gasCostUsd;
  rates.venueRate = async v => ({ protocol: v.protocol, ...table[v.protocol] });
  rules.gasCostUsd = async () => 0.05;
  t.after(() => { rates.venueRate = realRate; rules.gasCostUsd = realGas; });
  const ev = o => rules.evaluate({ chain: 'base', asset: 'USDC', amountUsd: 1000, feeBps: 10, ...o });

  const ok = await ev({ source: 'aave-v3', target: 'compound-v3' });
  assert.equal(ok.allowed, true, ok.reason);
  assert.deepEqual([ok.checks.gain_pct, ok.checks.fee_usd, ok.checks.extra_per_year_usd], [2, 1, 20]);

  assert.match((await ev({ source: 'compound-v3', target: 'aave-v3' })).reason, /below the 1-point minimum/);
  assert.match((await ev({ target: 'compound-v3', blocked: { 'compound-v3:base:USDC': 'a test warning' } })).reason, /risk watcher warns about it: a test warning/);
  table['compound-v3'] = rate(7, { utilization_pct: 96 });
  assert.match((await ev({ target: 'compound-v3' })).reason, /96% borrowed, at or above the 95% ceiling/);
  table['compound-v3'] = rate(7, { supply_open: false, flags: { supply_paused: true } });
  assert.match((await ev({ target: 'compound-v3' })).reason, /isn't taking deposits now \(supply paused\)/);
  table['compound-v3'] = rate(null, { error: 'rpc down' });
  assert.match((await ev({ target: 'compound-v3' })).reason, /couldn't be read \(rpc down\)/);
  table['compound-v3'] = rate(7);
  rules.gasCostUsd = async () => 9;
  const pricey = await ev({ source: 'aave-v3', target: 'compound-v3', amountUsd: 100 });
  assert.match(pricey.reason, /less than the up to \$9 of gas and \$0\.1 fee/);
  rules.gasCostUsd = async () => 0.05;
  assert.match((await ev({ target: 'uniswap' })).reason, /doesn't take USDC deposits/);

  // The per-protocol limit counts positions and idle money, and says what fits.
  const positions = { not_read: [], positions: [{ protocol: 'compound-v3', usd: 9000 }], idle: [{ usd: 11000 }, { usd: 500, gas: true }] };
  const tooMuch = await ev({ target: 'compound-v3', amountUsd: 5000, positions });
  assert.match(tooMuch.reason, /70% of the wallet's \$20000 of yield money into compound-v3/);
  assert.equal(tooMuch.checks.fits_usd, 3000);
  assert.equal((await ev({ target: 'compound-v3', amountUsd: 3000, positions })).allowed, true);
  const unread = await ev({ target: 'compound-v3', positions: { ...positions, not_read: [{ chain: 'base', what: 'Aave v3 USDC', reason: 'x' }] } });
  assert.match(unread.reason, /Not acting on partial data/);
});

test('move requests: chain, asset and venues from the list; an amount or all; from or to', () => {
  const w = '0x' + '11'.repeat(20);
  assert.match(proposals.parseMove({ wallet: 'x' }).error, /wallet/);
  assert.match(proposals.parseMove({ wallet: w, chain: 'polygon' }).error, /chain/);
  assert.match(proposals.parseMove({ wallet: w, chain: 'base', asset: 'USDT' }).error, /asset must be one of USDC, WETH/);
  assert.match(proposals.parseMove({ wallet: w, chain: 'base', asset: 'USDC', to: 'curve' }).error, /isn't a venue/);
  assert.match(proposals.parseMove({ wallet: w, chain: 'base', asset: 'USDC' }).error, /from or to/);
  assert.match(proposals.parseMove({ wallet: w, chain: 'base', asset: 'USDC', to: 'aave-v3', amount_usd: -1 }).error, /amount_usd/);
  assert.deepEqual(proposals.parseMove({ wallet: w, chain: 'base', asset: 'usdc', from: 'aave-v3', all: true }), { wallet: w, chain: 'base', asset: 'USDC', from: 'aave-v3', to: null, amount_usd: null, all: true });
});

test('the move fee: 0.1%, a transfer the user signs; proposals are in Safety Pro', () => {
  const p = catalog.product('yield_move');
  assert.deepEqual([p.kind, p.fee_bps], ['fee', 10]);
  assert.deepEqual(catalog.rails(p), ['claim_transfer']);
  assert.ok(catalog.SAFETY_PRO.covers.includes('yield_proposals'));
  assert.match(catalog.product('pro_30d').description, /yield proposals/);
  assert.equal(proposals.feeBps(), 10);
});

const DB = process.env.TEST_DATABASE_URL;
test('risk watcher: what counts as a warning, and a check that couldn\'t run isn\'t taken as clear', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  require('../src/config/env').databaseUrl = DB; // settings were read when the modules loaded
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  const cache = require('../src/lib/cache');
  const risk = require('../src/yield/risk');
  await cache.set('yield:risk:llama-coins', { WETH: 2000, USDC: 1, USDT: 1 }, 300);
  const realRate = rates.venueRate; const realPrice = rates.priceUsd;
  t.after(() => { rates.venueRate = realRate; rates.priceUsd = realPrice; });
  let prices = { USDC: 1, WETH: 2000 };
  rates.priceUsd = async (_c, a) => prices[a];
  const state = { 'aave-v3': { utilization_pct: 80, index: '1000', supplied: '5000000' }, 'compound-v3': { utilization_pct: 99, supplied: '2000000' }, 'spark-susdc': { utilization_pct: null, index: '500', supplied: '3000000' } };
  rates.venueRate = async (v, asset) => ({ apy_pct: 4, withdraw_open: true, ...state[v.protocol], ...(asset === 'WETH' ? { supplied: '10' } : {}) });

  const t0 = Date.now();
  let d = await risk.detect({ chains: ['base'], now: t0 });
  assert.equal(d.warnings['compound-v3:base:USDC'].severity, 'critical');
  assert.match(d.warnings['compound-v3:base:USDC'].reason, /99% borrowed/);
  assert.equal(d.warnings['aave-v3:base:USDC'], undefined);
  await db.query(`INSERT INTO yield_risk_state (key, value) VALUES ('index_highs', $1), ('supply_samples', $2)`, [JSON.stringify(d.highs), JSON.stringify(d.samples)]);

  // An hour later: Aave's index fell, Spark lost 40% of its supply, USDC slipped, Aave's WETH price is off the market.
  state['aave-v3'].index = '999';
  state['spark-susdc'].supplied = '1800000';
  prices = { USDC: 0.97, WETH: 2200 };
  d = await risk.detect({ chains: ['base'], now: t0 + 61 * 60000 });
  assert.match(d.warnings['aave-v3:base:USDC'].reason, /fell, which shouldn't happen|more than 5% from the market/);
  assert.equal(d.warnings['aave-v3:base:WETH'].severity, 'critical', 'a bad oracle price warns about every lending venue on the chain');
  assert.match(d.warnings['spark-susdc:base:USDC'].reason, /4\d% of .* supply on Base left in the last hour/); // 40% fewer USDC, at the slipped price
  assert.equal(d.warnings['spark-susdc:base:USDC'].severity, 'critical');

  // What couldn't be read: listed, and a standing warning stays up.
  await db.query(`INSERT INTO yield_risk_state (key, value) VALUES ('warnings', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ 'compound-v3:base:USDC': { severity: 'critical', reason: 'old', name: 'Compound v3 (USDC market)', asset: 'USDC', protocol: 'compound-v3', chain: 'base' } })]);
  state['compound-v3'] = { apy_pct: null, error: 'rpc down' };
  rates.venueRate = async (v, asset) => (v.protocol === 'compound-v3' ? { apy_pct: null, error: 'rpc down' } : { apy_pct: 4, withdraw_open: true, utilization_pct: 50, ...(asset === 'WETH' ? { supplied: '10' } : { supplied: '5000000' }) });
  prices = { USDC: 1, WETH: 2000 };
  const out = await risk.tick.call(null).catch(err => ({ err }));
  assert.ok(!out.err, out.err?.message);
  assert.ok(out.not_read.some(n => /Compound/.test(n.check)));
  assert.ok(Object.keys(await risk.blocked()).includes('compound-v3:base:USDC'), 'unread is not cleared');
});

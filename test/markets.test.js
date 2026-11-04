/**
 * Markets, with DefiLlama and CoinGecko as stand-ins: the overview (a part
 * that fails is named), stablecoin pegs and what backs them, the largest
 * tokens, and the API. Also the site-wide changes that came with it:
 * responses are compressed, and pages that only sign in don't load ethers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', ...(DB ? { DATABASE_URL: DB } : {}) });
const llama = require('../src/providers/llama');
const coingecko = require('../src/providers/coingecko');
const markets = require('../src/services/markets');

const days = n => Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10), tvl: 100e9 + i * 1e8 }));
const S = (symbol, extra) => ({ id: symbol, name: symbol + ' coin', symbol, peg: 'USD', mechanism: 'fiat-backed', price: 1, supply: 1e9, supply_prev_day: 1e9, supply_prev_week: 1e9, supply_prev_month: 1e9, chains: 3, ...extra });
const stub = ({ dexFail = false } = {}) => {
  llama.tvlHistory = async () => days(120);
  llama.dexVolume = async () => { if (dexFail) throw new Error('timeout'); return { total_24h: 8e9, change_1d: -10.1 }; };
  llama.fees = async () => ({ protocols: {}, total_24h: 6.6e7, change_1d: 0.3 });
  llama.stablecoins = async () => [
    S('USDT', { supply: 178e9, supply_prev_week: 180e9, price: 0.9986 }),
    S('DAI', { mechanism: 'crypto-backed', supply: 4.7e9, price: 1.0001 }),
    S('WOBBLY', { supply: 5e8, price: 0.97, supply_prev_week: 7e8 }),
    S('ALGO', { mechanism: 'algorithmic', supply: 6e8, supply_prev_week: 6e8, price: null }),
    S('EURC', { peg: 'EUR', supply: 2e8, price: 1.08 }),
  ];
};

test('overview: TVL now and its changes, DEX volume, fees, stablecoin supply; a part that fails is named', async () => {
  stub();
  const o = await markets.overview();
  assert.equal(o.tvl.usd, 100e9 + 119 * 1e8);
  assert.equal(o.tvl.history.length, 90);
  assert.equal(o.tvl.change_7d_pct, Math.round(((100e9 + 119e8) / (100e9 + 112e8) - 1) * 1000) / 10);
  assert.deepEqual(o.dex_volume, { usd_24h: 8e9, change_1d_pct: -10.1 });
  assert.equal(o.stablecoins.usd, 178e9 + 4.7e9 + 5e8 + 6e8, 'US dollar stablecoins only');
  assert.equal(o.stablecoins.count, 4);
  assert.deepEqual(o.not_checked, []);
  for (const k of ['tvl', 'dex_volume', 'fees', 'stablecoins']) assert.ok(o.sources[k], `${k} names its source`);
  stub({ dexFail: true });
  const p = await markets.overview();
  assert.equal(p.dex_volume, null);
  assert.deepEqual(p.not_checked, [{ check: 'DEX volume', reason: 'timeout' }]);
  llama.tvlHistory = llama.dexVolume = llama.fees = llama.stablecoins = async () => { throw new Error('down'); };
  await assert.rejects(markets.overview(), e => e instanceof markets.MarketsRefused && e.status === 503);
});

test('stablecoins: whether each holds its peg, what backs it, and whether people are leaving', async () => {
  stub();
  const s = await markets.stablecoinList();
  assert.deepEqual(s.stablecoins.map(c => c.symbol), ['USDT', 'DAI', 'ALGO', 'WOBBLY'], 'by supply; US dollar ones only');
  const by = Object.fromEntries(s.stablecoins.map(c => [c.symbol, c]));
  assert.deepEqual(by.USDT.signals.map(x => x.text), ['On its peg (price $0.9986)']);
  assert.deepEqual(by.WOBBLY.signals.map(x => [x.level, x.text]), [['bad', 'Off its peg by 3.0% (price $0.9700)'], ['warn', 'Supply down 29% in a week (holders redeeming or leaving)']]);
  assert.deepEqual(by.ALGO.signals.map(x => x.text), ['No price recorded, so its peg can\'t be checked', 'Algorithmic: its peg rests on a mechanism, not on reserves']);
  assert.equal(by.ALGO.peg_off_pct, null, 'no price: shown as missing');
  assert.equal(markets.stableSignals(S('X', { price: 0.994 }))[0].level, 'warn', 'half a percent off is worth a look');
  assert.deepEqual(s.by_mechanism.map(m => m.mechanism), ['fiat-backed', 'crypto-backed', 'algorithmic']);
  assert.match(s.note, /says nothing about the reserves/);
});

test('tokens: the largest by market cap, attributed to CoinGecko; a busy CoinGecko is said so', async () => {
  coingecko.topTokens = async () => [
    { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', rank: 1, price_usd: 78000, from_ath_pct: -38, ath_date: '2025-10-06' },
    { id: 'dogecoin', symbol: 'DOGE', name: 'Dogecoin', rank: 9, price_usd: 0.07, from_ath_pct: -90, ath_date: '2021-05-07' },
  ];
  const t = await markets.tokens();
  assert.deepEqual(t.tokens[0].signals, []);
  assert.equal(t.tokens[1].signals[0].text, '90% below its high (2021-05-07)');
  assert.equal(t.tokens[0].link, 'https://www.coingecko.com/en/coins/bitcoin');
  assert.match(t.source, /^Data from CoinGecko/);
  coingecko.topTokens = async () => { throw Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } }); };
  await assert.rejects(markets.tokens(), /CoinGecko didn't answer \(its free plan is busy\)/);
});

test('API and the site-wide changes: compressed responses; pages that only sign in skip ethers', async t => {
  stub();
  coingecko.topTokens = async () => [{ id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', rank: 1, from_ath_pct: -10 }];
  const server = require('../src/app').createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const p of ['/v1/markets/overview', '/v1/markets/stablecoins', '/v1/markets/tokens']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('cache-control'), /max-age=60/);
  }
  const page = await fetch(base + '/markets', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(page.headers.get('content-encoding'), 'gzip', 'pages are compressed');
  const html = await page.text();
  assert.ok(html.includes('<a href="/markets" aria-current="page">'));
  for (const p of ['/', '/discover', '/markets', '/find', '/governance', '/extension', '/privacy']) {
    assert.ok(!(await (await fetch(base + p)).text()).includes('ethers.umd.min.js'), `${p} doesn't load ethers`);
  }
  for (const p of ['/safety', '/trade']) assert.ok((await (await fetch(base + p)).text()).includes('ethers.umd.min.js'), `${p} still does (its own code uses it)`);
  const js = await fetch(base + '/vendor/ethers.umd.min.js', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(js.headers.get('content-encoding'), 'gzip');
});

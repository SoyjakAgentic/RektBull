/**
 * The token page (Trade desk, stage 1): its facts with their sources, the
 * creator's holdings read now, links checked for phishing, trades seen from
 * the token's side of the pool, candles, and what it says when a source is down.
 * Every provider is a stand-in; no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
const env = require('../src/config/env');
env.databaseUrl = ''; // the in-process cache only

const axios = require('axios');
const cache = require('../src/lib/cache');
const dexscreener = require('../src/providers/dexscreener');
const gt = require('../src/providers/geckoterminal');
const goplus = require('../src/providers/goplus');
const discover = require('../src/services/discover');
const launchpads = require('../src/services/launchpads');
const approvals = require('../src/services/approvals');
const tokenPage = require('../src/services/tokenPage');

const TOKEN = '0x' + 'ab'.repeat(20);
const POOL = '0x' + 'cd'.repeat(20);
const CREATOR = '0x' + 'c0'.repeat(20);
const WETH = '0x4200000000000000000000000000000000000006';
const LOCKER = '0x' + '1c'.repeat(20);

test('the token page', async t => {
  const saved = { market: dexscreener.market, gp: discover.goplusReport, id: launchpads.identify, phish: goplus.phishingSite, mc: approvals.multicall, get: axios.get, retry: gt.RETRY_MS };
  t.after(() => {
    dexscreener.market = saved.market; discover.goplusReport = saved.gp; launchpads.identify = saved.id;
    goplus.phishingSite = saved.phish; approvals.multicall = saved.mc; axios.get = saved.get; gt.RETRY_MS = saved.retry;
  });
  gt.RETRY_MS = 0;
  const fresh = () => cache._memory.clear();

  dexscreener.market = async () => ({
    source: 'DexScreener', pairs: 2, price_usd: 0.00074, change_24h_pct: -3.2, liquidity_usd_total: 120000, volume_24h_usd: 50000, market_cap_usd: 900000,
    first_pair_created_at: new Date(Date.now() - 30 * 3600000).toISOString(),
    main_pair: { dex: 'uniswap', address: POOL, quote: 'WETH' }, token_name: 'Test Coin', token_symbol: 'TEST',
    links: [{ label: 'Website', url: 'https://test.example/' }, { label: 'Twitter', url: 'https://x.com/test' }, { label: 'Claim', url: 'https://claim-test.example/airdrop' }],
  });
  discover.goplusReport = async () => ({
    honeypot: false, holder_count: 4200, top10_people_pct: 22.5, creator_address: CREATOR,
    top_holders: [
      { address: POOL, is_contract: true, is_locked: false, share: 0.41 },
      { address: LOCKER, is_contract: true, is_locked: true, tag: 'UNCX', share: 0.2 },
      { address: '0x000000000000000000000000000000000000dEaD', is_contract: false, is_locked: false, share: 0.1 },
      { address: CREATOR, is_contract: false, is_locked: false, share: 0.05 },
      { address: '0x' + '77'.repeat(20), is_contract: false, is_locked: false, share: null },
    ],
  });
  launchpads.identify = async () => ({ launchpad: null });
  goplus.phishingSite = async origin => {
    if (origin === 'https://claim-test.example') return { phishing: true };
    if (origin === 'https://x.com') throw new Error('timeout');
    return { phishing: false };
  };
  let creatorBalance = 30n;
  approvals.multicall = async (_chain, calls) => calls.map(c => ({ ok: true, value: [c.fn === 'balanceOf' ? creatorBalance : 1000n] }));

  await t.test('facts, each with its source; holders marked; the creator\'s share read now; links checked', async () => {
    fresh();
    const p = await tokenPage.page({ chain: 'BASE', token: TOKEN.toUpperCase().replace('0X', '0x') });
    assert.equal(p.chain, 'base');
    assert.equal(p.token, TOKEN);
    assert.equal(p.symbol, 'TEST');
    assert.equal(p.market.price_usd, 0.00074);
    assert.equal(p.market.age_hours, 30);
    assert.match(p.market.source, /DexScreener/);
    assert.deepEqual(p.pool, { address: POOL, dex: 'uniswap', quote: 'WETH', source: 'DexScreener: its most liquid pair' });
    assert.deepEqual(p.holders.top.map(h => [h.kind, h.pct]), [['pool', 41], ['locked', 20], ['burn', 10], ['creator', 5], ['wallet', null]]);
    assert.equal(p.holders.top[1].tag, 'UNCX');
    assert.match(p.holders.source, /GoPlus/);
    // GoPlus said 5% (cached); the chain says 3% now: the page shows now.
    assert.deepEqual([p.creator.address, p.creator.holds_pct], [CREATOR, 3]);
    assert.match(p.creator.source, /GoPlus.*read now from Base/);
    assert.deepEqual(p.links.list.map(l => [l.host, l.phishing, l.checked]), [['test.example', false, true], ['x.com', null, false], ['claim-test.example', true, true]]);
    assert.match(p.links.list[1].not_checked, /phishing list couldn't be read: timeout/);
    assert.equal(p.launchpad, null);
    assert.ok(p.flags.flags.length, 'GoPlus\'s flags, from the same report');
  });

  await t.test('a Virtuals token on its curve: the creator from Virtuals\' contract, its links, how close it is to graduating', async () => {
    fresh();
    const m = dexscreener.market;
    dexscreener.market = async () => ({ source: 'DexScreener', pairs: 0, note: 'No trading pairs found on this chain' });
    launchpads.identify = async () => ({ launchpad: 'virtuals', name: 'Virtuals', ticker: 'VCOIN', creator: '0x' + 'f1'.repeat(20), state: 'curve', link: 'https://app.virtuals.io/prototypes/x', source: 'Virtuals\' Bonding contract',
      links: [{ label: 'Twitter', url: 'https://x.com/vcoin' }],
      curve: { progress_pct: 62.5, in_curve: 4100, in_curve_symbol: 'VIRTUAL', graduates_at: 125000000, buy_tax_pct: 1, sell_tax_pct: 1 } });
    goplus.phishingSite = async () => ({ phishing: false });
    const p = await tokenPage.page({ chain: 'base', token: TOKEN });
    assert.equal(p.symbol, 'VCOIN');
    assert.equal(p.pool, null);
    assert.equal(p.launchpad.curve.progress_pct, 62.5);
    assert.equal(p.creator.address, '0x' + 'f1'.repeat(20));
    assert.match(p.creator.source, /Virtuals' contract/);
    assert.deepEqual(p.links.list.map(l => l.host), ['x.com']);
    assert.match(p.links.source, /creator's links on Virtuals/);
    // No pool: no trades and no chart, each saying why.
    const tr = await tokenPage.trades({ chain: 'base', token: TOKEN });
    assert.deepEqual(tr.trades, []);
    assert.match(tr.not_checked, /no pool/);
    assert.match((await tokenPage.candles({ chain: 'base', token: TOKEN })).not_checked, /no pool for it yet/);
    dexscreener.market = m;
    launchpads.identify = async () => ({ launchpad: null });
  });

  await t.test('a source that couldn\'t be read says why; the rest of the page stands', async () => {
    fresh();
    const gp = discover.goplusReport;
    discover.goplusReport = async () => { throw new Error('GoPlus: 503'); };
    approvals.multicall = async () => [{ ok: false }, { ok: true, value: [1000n] }];
    const p = await tokenPage.page({ chain: 'base', token: TOKEN });
    assert.match(p.holders.not_checked, /GoPlus couldn't be read: GoPlus: 503/);
    assert.match(p.creator.not_checked, /doesn't name a creator|couldn't be read/);
    assert.match(p.flags.not_checked, /503/);
    assert.equal(p.market.price_usd, 0.00074, 'the market still shows');
    discover.goplusReport = gp;
    fresh();
    const q = await tokenPage.page({ chain: 'base', token: TOKEN });
    assert.match(q.creator.not_checked, /couldn't be read from Base: the token didn't answer/);
    assert.equal(q.creator.address, CREATOR);
    approvals.multicall = async (_c, calls) => calls.map(c => ({ ok: true, value: [c.fn === 'balanceOf' ? creatorBalance : 1000n] }));
  });

  await t.test('trades: buys and sells as seen from the token, though it is the pool\'s quote side; cached 15 seconds', async () => {
    fresh();
    let calls = 0;
    axios.get = async url => {
      calls++;
      assert.equal(url, `https://api.geckoterminal.com/api/v2/networks/base/pools/${POOL}/trades`);
      return { data: { data: [
        { attributes: { block_timestamp: '2026-11-13T19:12:06Z', kind: 'sell', from_token_address: WETH, to_token_address: TOKEN, from_token_amount: '0.01', to_token_amount: '25000', price_from_in_usd: '1948', price_to_in_usd: '0.00078', volume_in_usd: '19.48', tx_from_address: '0xAa' + 'a'.repeat(38), tx_hash: '0x' + '1'.repeat(64) } },
        { attributes: { block_timestamp: '2026-11-13T19:11:00Z', kind: 'buy', from_token_address: TOKEN, to_token_address: WETH, from_token_amount: '1000', to_token_amount: '0.0004', price_from_in_usd: '0.00077', price_to_in_usd: '1948', volume_in_usd: '0.77', tx_from_address: '0x' + 'b'.repeat(40), tx_hash: '0x' + '2'.repeat(64) } },
        { attributes: { block_timestamp: '2026-11-13T19:10:00Z', kind: 'buy', from_token_address: WETH, to_token_address: '0x' + '99'.repeat(20), volume_in_usd: '5' } },
      ] } };
    };
    const r = await tokenPage.trades({ chain: 'base', token: TOKEN });
    assert.deepEqual(r.trades.map(x => [x.side, x.tokens, x.usd, x.price_usd]), [['buy', 25000, 19.48, 0.00078], ['sell', 1000, 0.77, 0.00077]], 'GeckoTerminal\'s "sell" of the pool\'s base is a buy of this token');
    assert.equal(r.trades[0].wallet, '0xaa' + 'a'.repeat(38));
    assert.match(r.source, /GeckoTerminal/);
    await tokenPage.trades({ chain: 'base', token: TOKEN });
    assert.equal(calls, 1, 'cached');
  });

  await t.test('candles: in dollars for this token, oldest first; GeckoTerminal busy is said, not hidden', async () => {
    fresh();
    let asked = null;
    axios.get = async (url, { params }) => {
      asked = { url, params };
      return { data: { data: { attributes: { ohlcv_list: [[1794597000, 2, 3, 1, 2.5, 10], [1794596700, 1, 2, 0.5, 2, 5], [1794596400, 'x', 1, 1, 1, 1]] } } } };
    };
    const c = await tokenPage.candles({ chain: 'base', token: TOKEN, size: '5m' });
    assert.equal(asked.url, `https://api.geckoterminal.com/api/v2/networks/base/pools/${POOL}/ohlcv/minute`);
    assert.deepEqual(asked.params, { aggregate: 5, limit: 144, currency: 'usd', token: TOKEN });
    assert.deepEqual(c.candles.map(r => r[0]), [1794596700, 1794597000], 'oldest first; a malformed row dropped');
    await assert.rejects(tokenPage.candles({ chain: 'base', token: TOKEN, size: '1w' }), /size must be one of: 5m, 1h, 1d/);

    fresh();
    axios.get = async () => { throw Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } }); };
    const busy = await tokenPage.candles({ chain: 'base', token: TOKEN, size: '1h' });
    assert.deepEqual(busy.candles, []);
    assert.match(busy.not_checked, /GeckoTerminal couldn't be read: it's busy \(free plan limit\); try again in a minute/);
    assert.equal(cache._memGet(`gt:candles:base:${POOL}:${TOKEN}:1h`), undefined, 'a failure isn\'t cached');
  });

  await t.test('refused: a chain it doesn\'t cover, or not an address', async () => {
    await assert.rejects(tokenPage.page({ chain: 'solana', token: TOKEN }), e => e instanceof tokenPage.TokenPageRefused && /chain must be one of: base, ethereum, arbitrum, bsc/.test(e.message));
    await assert.rejects(tokenPage.page({ chain: 'base', token: 'nope' }), /token must be a contract address/);
  });

  await t.test('the page and its API over HTTP: served, not indexed; a bad request is a 400', async () => {
    const { createApp } = require('../src/app');
    const server = createApp().listen(0);
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const html = await (await fetch(`${base}/token?chain=base&token=${TOKEN}`)).text();
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.match(html, /<script src="\/token.js">/);
    assert.match(html, /aria-current="page">Launches/, 'the menu marks Launches');
    const bad = await fetch(`${base}/v1/tokens/solana/${TOKEN}/page`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'refused');
    const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
    assert.doesNotMatch(sitemap, /\/token(\?|<)/, 'not in the sitemap');
  });
});

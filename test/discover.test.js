/**
 * Discover, with DefiLlama, GeckoTerminal and GoPlus as stand-ins: the safety
 * facts on each dapp, rankings per chain, categories, chains, the warning
 * signs on trending and new tokens, free flags (never caching a miss), and
 * the API with its limits.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', ...(DB ? { DATABASE_URL: DB } : {}) });
const llama = require('../src/providers/llama');
const gt = require('../src/providers/geckoterminal');
const tokenRisk = require('../src/services/tokenRisk');
const discover = require('../src/services/discover');
const cache = require('../src/lib/cache');

const NOW = Date.now();
const P = (id, name, extra) => ({ id, name, slug: name.toLowerCase().replace(/ /g, '-'), category: 'Lending', chains: ['ethereum', 'base'], chain_count: 2, tvl: 1000, chain_tvl: { ethereum: 700, base: 300 }, change_1d: 0, change_7d: 1, audit_links: ['https://a'], listed_at: Math.floor(NOW / 1000) - 400 * 86400, url: 'https://x', logo: null, token: null, tvl_doubted: false, ...extra });
const PROTOCOLS = [
  P('1', 'Big Lend', { tvl: 5e9, chain_tvl: { ethereum: 4e9, base: 1e9 }, token: { chain: 'ethereum', address: '0x' + '11'.repeat(20) } }),
  P('2', 'Base Dex', { category: 'Dexs', chains: ['base'], chain_count: 1, tvl: 2e9, chain_tvl: { base: 2e9 } }),
  P('3', 'New Farm', { category: 'Yield', tvl: 1e8, chain_tvl: { ethereum: 1e8 }, audit_links: [], listed_at: Math.floor(NOW / 1000) - 10 * 86400, change_7d: -45 }),
  P('4', 'Hacked Bridge', { category: 'Bridge', tvl: 3e9, chain_tvl: { ethereum: 3e9 }, tvl_doubted: true }),
];
const stubLlama = ({ feesFail = false, protocolsFail = false } = {}) => {
  llama.protocols = async () => { if (protocolsFail) throw new Error('timeout'); return PROTOCOLS; };
  llama.fees = async () => { if (feesFail) throw new Error('503 from DefiLlama'); return { protocols: { 1: { total: 50000, chains: { ethereum: 30000, base: 20000 } }, 2: { total: 90000, chains: { base: 90000 } } }, total_24h: 140000, change_1d: 2 }; };
  llama.hacks = async () => ({ 4: [{ date: '2022-02-02', amount_usd: 326e6, technique: 'Signature Verification Flaw', returned_usd: 326e6 }] });
  llama.chains = async () => [{ name: 'Ethereum', tvl: 4e10, token: 'ETH', rektbull: 'ethereum' }, { name: 'Tron', tvl: 5e9, token: 'TRX', rektbull: null }, { name: 'Base', tvl: 6e9, token: null, rektbull: 'base' }];
};

test('tokenOf: DefiLlama token addresses on RektBull chains only', () => {
  assert.deepEqual(llama.tokenOf('0x' + 'AB'.repeat(20)), { chain: 'ethereum', address: '0x' + 'ab'.repeat(20) });
  assert.deepEqual(llama.tokenOf('bsc:0x' + '12'.repeat(20)), { chain: 'bsc', address: '0x' + '12'.repeat(20) });
  assert.equal(llama.tokenOf('tron:TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9'), null);
  assert.equal(llama.tokenOf('-'), null);
  assert.equal(llama.tokenOf(null), null);
});

test('dapps: the safety facts, each with its source; a missing fact is never filled in', async () => {
  stubLlama();
  const r = await discover.dapps({});
  assert.deepEqual(r.dapps.map(d => d.name), ['Big Lend', 'Hacked Bridge', 'Base Dex', 'New Farm'], 'by TVL');
  const by = Object.fromEntries(r.dapps.map(d => [d.name, d]));
  assert.equal(by['Hacked Bridge'].signals[0].level, 'bad');
  assert.equal(by['Hacked Bridge'].signals[0].text, 'Hacked 2022-02-02: $326M lost (Signature Verification Flaw), $326M returned');
  assert.ok(by['Hacked Bridge'].signals.some(s => /TVL may be misreported/.test(s.text)));
  assert.deepEqual(by['New Farm'].signals.map(s => s.text), ['No audit listed', 'Listed 10 days ago', 'TVL down 45% in a week']);
  assert.equal(by['Big Lend'].signals[0].level, 'ok');
  for (const d of r.dapps) for (const s of d.signals) assert.ok(s.source, 'every signal names its source');
  assert.equal(by['Big Lend'].token.check, `/safety?chain=ethereum&token=0x${'11'.repeat(20)}`);
  assert.equal(by['New Farm'].fees_24h_usd, null, 'no fee data: shown as missing, not zero');
  assert.match(r.note, /not whether it is safe/);
});

test('dapps: per chain, the chain\'s own TVL and fees; ranked by fees; a category', async () => {
  stubLlama();
  let r = await discover.dapps({ chain: 'base', sort: 'fees' });
  assert.deepEqual(r.dapps.map(d => [d.name, d.tvl_usd, d.fees_24h_usd]), [['Base Dex', 2e9, 90000], ['Big Lend', 1e9, 20000]]);
  assert.deepEqual(r.categories, ['Dexs', 'Lending']);
  r = await discover.dapps({ category: 'Yield' });
  assert.deepEqual(r.dapps.map(d => d.name), ['New Farm']);
  r = await discover.dapps({ sort: 'change_7d', limit: 1 });
  assert.equal(r.dapps.length, 1); assert.equal(r.total, 4);
});

test('dapps: a source that fails is named; without the protocol list there is no answer', async () => {
  stubLlama({ feesFail: true });
  const r = await discover.dapps({});
  assert.deepEqual(r.not_checked, [{ check: 'fees in the last 24 hours', reason: '503 from DefiLlama' }]);
  assert.ok(r.dapps.every(d => d.fees_24h_usd === null));
  stubLlama({ protocolsFail: true });
  await assert.rejects(discover.dapps({}), e => e instanceof discover.DiscoverRefused && e.status === 503 && /DefiLlama didn't answer/.test(e.message));
});

test('categories and chains', async () => {
  stubLlama();
  const c = await discover.categories({});
  assert.deepEqual(c.categories.map(x => x.category), ['Lending', 'Bridge', 'Dexs', 'Yield']);
  assert.deepEqual(c.categories[0].top, ['Big Lend']);
  const yieldCat = c.categories.find(x => x.category === 'Yield');
  assert.equal(yieldCat.change_7d_pct, -45, 'the weekly change, from each dapp\'s own');
  const ch = await discover.chainList();
  assert.deepEqual(ch.chains.map(x => [x.name, x.dapps, x.rektbull]), [['Ethereum', 3, 'ethereum'], ['Base', 2, 'base'], ['Tron', null, null]]);
});

const POOL = (sym, extra) => ({ pool: '0xpool' + sym, name: `${sym} / WETH`, dex: 'aerodrome', token: { address: '0x' + sym.charCodeAt(0).toString(16).padStart(2, '0').repeat(20), symbol: sym, name: sym + ' Token' }, quote: 'WETH', price_usd: 1, change_24h_pct: 5, change_1h_pct: 0, volume_24h_usd: 1e6, liquidity_usd: 5e5, fdv_usd: 1e7, market_cap_usd: null, created_at: new Date(NOW - 90 * 86400000).toISOString(), buys_24h: 300, sells_24h: 250, buyers_24h: 100, sellers_24h: 90, ...extra });

test('tokens: the warning signs a pool\'s own trading shows', async () => {
  gt.pools = async () => [
    POOL('A'),
    POOL('B', { created_at: new Date(NOW - 3 * 3600000).toISOString(), liquidity_usd: 9000, buys_24h: 120, sells_24h: 0, change_24h_pct: 900 }),
    POOL('A', { pool: '0xsecondpool' }),
  ];
  const r = await discover.tokens({ list: 'new', chain: 'base' });
  assert.deepEqual(r.tokens.map(t => t.token.symbol), ['A', 'B'], 'one row per token');
  assert.deepEqual(r.tokens[0].signals, []);
  assert.deepEqual(r.tokens[1].signals.map(s => s.text), ['Pool opened 3 hours ago', 'Liquidity $9K: a large sale moves the price a lot', '120 buys and no sells in 24 hours: a common sign of a token that can\'t be sold (a pattern, not proof)', 'Up 900% in 24 hours']);
  assert.equal(r.tokens[1].check, `/safety?chain=base&token=${r.tokens[1].token.address}`);
  assert.match(r.note, /most scams start/);
  gt.pools = async () => { throw Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } }); };
  await assert.rejects(discover.tokens({ list: 'trending', chain: 'base' }), /GeckoTerminal didn't answer \(its free plan is busy\)/);
});

test('flags: GoPlus\'s flags for one token, cached; a miss is never cached', async () => {
  cache._memory.clear();
  let calls = 0;
  tokenRisk.goplus = async () => { calls++; return calls === 1 ? { not_checked: 'GoPlus: rate limited' } : { honeypot: true, sell_tax_pct: 35, buy_tax_pct: 0, mintable: false, proxy: true, holder_count: 40, top10_people_pct: 80, lp_locked_pct: 0 }; };
  const token = '0x' + 'cd'.repeat(20);
  assert.deepEqual(await discover.flags({ chain: 'base', token }), { chain: 'base', token, not_checked: 'GoPlus: rate limited' });
  const f = await discover.flags({ chain: 'base', token });
  assert.deepEqual(f.flags.map(x => x.level), ['bad', 'bad', 'warn', 'warn']);
  assert.match(f.flags[0].text, /honeypot/);
  assert.match(f.flags[1].text, /35% to sell/);
  await discover.flags({ chain: 'base', token });
  assert.equal(calls, 2, 'the answer was cached; the miss wasn\'t');
  assert.match((await discover.flags({ chain: 'solana', token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' })).not_checked, /quick check covers Solana/);
});

test('input rules', () => {
  assert.match(discover.parseDapps({ chain: 'tron' }).error, /chain must be/);
  assert.match(discover.parseDapps({ sort: 'x' }).error, /sort must be/);
  assert.match(discover.parseDapps({ limit: '500' }).error, /1 to 100/);
  assert.deepEqual(discover.parseDapps({ limit: '20', chain: 'base' }), { chain: 'base', sort: 'tvl', limit: 20, category: null });
  assert.match(discover.parseTokens({ list: 'hot' }).error, /trending or new/);
  assert.match(discover.parseFlags({ chain: 'base', token: 'x' }).error, /token's address/);
});

test('API: free and cached; flags have a daily limit', { skip: !DB && 'set TEST_DATABASE_URL' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const server = require('../src/app').createApp().listen(0);
  t.after(async () => { server.close(); await db.getPool().end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  stubLlama();
  gt.pools = async () => [POOL('A')];
  tokenRisk.goplus = async () => ({ honeypot: false });
  const page = await fetch(base + '/discover');
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('<a href="/discover" aria-current="page">'));
  let r = await fetch(base + '/v1/discover/dapps?chain=base');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /max-age=60/);
  assert.equal((await r.json()).dapps.length, 2);
  assert.equal((await fetch(base + '/v1/discover/dapps?sort=x')).status, 400);
  assert.equal((await (await fetch(base + '/v1/discover/tokens?list=trending&chain=base')).json()).tokens.length, 1);
  assert.equal((await fetch(base + '/v1/discover/chains')).status, 200);
  assert.equal((await fetch(base + '/v1/discover/categories?chain=base')).status, 200);
  stubLlama({ protocolsFail: true });
  r = await fetch(base + '/v1/discover/categories');
  assert.equal(r.status, 503);
  for (let i = 0; i < 20; i++) assert.equal((await fetch(`${base}/v1/discover/flags?chain=base&token=0x${'cd'.repeat(20)}`)).status, 200);
  r = await fetch(`${base}/v1/discover/flags?chain=base&token=0x${'cd'.repeat(20)}`);
  assert.equal(r.status, 429);
  assert.match((await r.json()).message, /20 a day without signing in/);
});

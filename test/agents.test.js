/**
 * Agents, with the x402 Bazaar, GoPlus and DefiLlama as stand-ins: listings
 * read as endpoints (testnets out, prices only in known stablecoins),
 * grouped into services, ranked by real payers with the noise left out, the
 * signals (generated-looking usage, few users, no recent calls, plain http,
 * a flagged payment address), filters, a source that doesn't answer, the
 * AI-agent protocols, the API and the MCP tool.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: '' });
const bazaar = require('../src/providers/x402bazaar');
const goplus = require('../src/providers/goplus');
const agents = require('../src/services/agents');

const NOW = Date.UTC(2026, 10, 4, 12);
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const item = (url, { service = null, payers = 100, calls = 1000, last = '2026-11-03T10:00:00Z', network = 'eip155:8453', asset = BASE_USDC, amount = '5000', payTo = '0x' + '11'.repeat(20), tags = [] } = {}) => ({
  resource: url, serviceName: service, description: `${service || url} does a thing`, tags,
  accepts: [{ scheme: 'exact', network, asset, amount, payTo, resource: url }],
  extensions: { bazaar: { info: { input: { method: 'GET' } } } },
  quality: { l30DaysTotalCalls: calls, l30DaysUniquePayers: payers, lastCalledAt: last },
});
const ITEMS = [
  item('https://api.search.example/web', { service: 'Search Co', payers: 300, calls: 90000, tags: ['search', 'web'] }),
  item('https://api.search.example/news', { service: 'Search Co', payers: 120, calls: 5000, amount: '10000', tags: ['news'] }),
  item('https://busy.example/q', { service: 'Busy Looking', payers: 490, calls: 495, payTo: '0x' + '22'.repeat(20) }),
  item('https://many.example/a', { service: 'Many Endpoints', payers: 200, calls: 205 }),
  item('https://many.example/b', { service: 'Many Endpoints', payers: 150, calls: 40000 }),
  item('https://quiet.example/x', { service: 'Quiet', payers: 8, calls: 40, last: '2026-10-01T00:00:00Z', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: 'So1anaPayTo111111111111111111111111111111111', tags: ['prices'] }),
  item('http://plain.example/p', { service: 'Plain', payers: 30, calls: 900, asset: '0x' + '99'.repeat(20), amount: '7' }),
  item('https://drainy.example/d', { service: 'Drainy', payers: 60, calls: 2000, payTo: '0x' + 'dd'.repeat(20) }),
  item('https://noise.example/n', { service: 'Noise', payers: 2, calls: 3 }),
  item('https://test.example/t', { service: 'Testnet', payers: 500, calls: 9000, network: 'eip155:84532' }),
];
const stub = ({ listing = true, goplusDown = false } = {}) => {
  bazaar.listing = async () => {
    if (!listing) throw new Error('timeout of 20000ms exceeded');
    return { endpoints: ITEMS.map(bazaar.endpoint).filter(Boolean), listed_total: 114274, read: ITEMS.length, read_at: '2026-11-04T09:00:00Z' };
  };
  goplus.addressRisk = async (chain, address) => {
    if (goplusDown) throw new Error('GoPlus didn\'t answer');
    return { source: 'GoPlus', flags: address === '0x' + 'dd'.repeat(20) ? ['Phishing activities', 'Stealing attack'] : [] };
  };
};

test('a listing read as an endpoint: testnets out, prices only in stablecoins RektBull knows', () => {
  const e = bazaar.endpoint(ITEMS[0]);
  assert.deepEqual([e.host, e.price_usd, e.networks, e.payers_30d, e.method], ['api.search.example', 0.005, ['base'], 300, 'GET']);
  const named = name => ITEMS.find(i => i.serviceName === name);
  assert.equal(bazaar.endpoint(named('Quiet')).price_usd, 0.005, 'USDC on Solana');
  assert.equal(bazaar.endpoint(named('Plain')).price_usd, null, 'an unknown token isn\'t read as dollars');
  assert.equal(bazaar.endpoint(named('Testnet')), null, 'testnet only: left out');
  assert.equal(bazaar.endpoint({ ...ITEMS[0], resource: 'not a url', accepts: [{ ...ITEMS[0].accepts[0], resource: 'not a url' }] }), null);
  const v1 = bazaar.endpoint({ resource: 'https://v1.example/a', accepts: [{ network: 'base', asset: BASE_USDC, maxAmountRequired: '250000', payTo: '0x' + '33'.repeat(20) }] });
  assert.deepEqual([v1.price_usd, v1.networks], [0.25, ['base']], 'x402 v1 listings too');
});

test('services: grouped by host, ranked by payers, noise left out, each with what its numbers suggest', async () => {
  stub();
  const r = await agents.x402Services({}, NOW);
  assert.deepEqual(r.services.map(s => s.name), ['Busy Looking', 'Search Co', 'Many Endpoints', 'Drainy', 'Plain', 'Quiet']);
  assert.equal(r.total, 6, 'fewer than 5 payers: left out');
  const search = r.services.find(s => s.name === 'Search Co');
  assert.deepEqual([search.endpoints, search.payers_30d, search.calls_30d, search.price_usd], [2, 300, 95000, { min: 0.005, max: 0.01 }]);
  assert.deepEqual(search.tags, ['search', 'web', 'news']);
  assert.deepEqual(search.signals, [], 'a busy service people come back to: nothing to say');

  const text = name => r.services.find(s => s.name === name).signals.map(s => `${s.level}: ${s.text}`);
  assert.deepEqual(text('Busy Looking'), ['warn: 495 calls from 490 different payers in 30 days, about one each. Real users usually come back, so some of this traffic may be generated to look busy']);
  assert.deepEqual(text('Many Endpoints'), ['warn: Its busiest endpoint had 205 calls from 200 different payers in 30 days, about one each. Real users usually come back, so some of this traffic may be generated to look busy'], 'not hidden by the totals (40,205 calls)');
  assert.deepEqual(text('Quiet'), ['info: Few users: 8 payers in 30 days', 'warn: No calls in 34 days']);
  assert.ok(text('Plain').includes('warn: Some endpoints use plain http: requests and answers can be read or changed on the way'));
  assert.equal(text('Drainy')[0], `bad: GoPlus flags the address it's paid to (0xdddd…dddd on base): Phishing activities, Stealing attack`, 'a flagged payment address comes first');
  assert.deepEqual(r.services.find(s => s.name === 'Drainy').check_pay_to, [`/?q=0x${'dd'.repeat(20)}`]);
  assert.match(r.note, /RektBull hasn't tested any/);
  assert.equal(r.read.listed, 114274);
  assert.deepEqual(r.not_checked, []);
});

test('filters, a GoPlus check that couldn\'t run, and a Bazaar that doesn\'t answer', async () => {
  stub();
  assert.deepEqual((await agents.x402Services({ network: 'solana' }, NOW)).services.map(s => s.name), ['Quiet']);
  assert.deepEqual((await agents.x402Services({ query: 'news' }, NOW)).services.map(s => s.name), ['Search Co'], 'matches tags too');
  assert.deepEqual((await agents.x402Services({ limit: 2 }, NOW)).services.length, 2);
  assert.match(agents.parseX402({ limit: '500' }).error, /1 to 100/);
  assert.match(agents.parseX402({ network: 'no spaces!' }).error, /network must be/);

  stub({ goplusDown: true });
  const r = await agents.x402Services({}, NOW);
  assert.deepEqual(r.not_checked, [{ check: 'payment addresses (GoPlus)', reason: '5 checks couldn\'t run: GoPlus didn\'t answer' }], 'named, not hidden');
  assert.ok(!r.services.some(s => s.signals.some(x => x.level === 'bad')));

  stub({ listing: false });
  await assert.rejects(agents.x402Services({}, NOW), err => err.status === 503 && /The x402 Bazaar didn't answer \(timeout/.test(err.message));
});

test('the AI-agent protocols, the API and the MCP tool', async () => {
  stub();
  const discover = require('../src/services/discover');
  let asked;
  discover.dapps = async input => { asked = input; return { total: 1, dapps: [{ name: 'Agent Launchpad', signals: [] }], not_checked: [], sources: ['DefiLlama protocols'], note: 'A ranking shows how much is in a dapp, not whether it is safe.' }; };
  const p = await agents.protocols({ sort: 'fees' });
  assert.deepEqual(asked, { category: 'AI Agents', sort: 'fees', limit: 100 });
  assert.match(p.note, /^Onchain AI-agent protocols as DefiLlama lists them \(category "AI Agents"\)\. A ranking shows/);

  const server = require('../src/app').createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const x = await fetch(base + '/v1/agents/x402?network=base&limit=3');
    assert.equal(x.status, 200);
    assert.equal((await x.json()).services.length, 3);
    assert.equal((await fetch(base + '/v1/agents/x402?limit=0')).status, 400);
    assert.equal((await (await fetch(base + '/v1/agents/protocols')).json()).protocols[0].name, 'Agent Launchpad');
    assert.equal((await fetch(base + '/v1/agents/protocols?sort=nope')).status, 400);
    stub({ listing: false });
    assert.equal((await fetch(base + '/v1/agents/x402')).status, 503);
    stub();
    const mcp = await (await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x402_services', arguments: { q: 'search' } } }) })).json();
    assert.deepEqual(mcp.result.structuredContent.services.map(s => s.name), ['Search Co']);
  } finally { server.close(); }
});

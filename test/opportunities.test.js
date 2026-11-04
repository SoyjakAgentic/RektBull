/**
 * Opportunities, with Merkl and DefiLlama as stand-ins: which campaigns are
 * listed, the facts on each (the protocol's record, the action's risk, an
 * unverified reward token, an early end), sorting, a chain that doesn't
 * answer, and the API. Also the menu: Find money and Governance sit under it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '' });
const merkl = require('../src/providers/merkl');
const llama = require('../src/providers/llama');
const opp = require('../src/services/opportunities');

const NOW = Date.now();
const C = (id, extra) => ({
  id, chain: 'base', name: `Campaign ${id}`, action: 'LEND', type: 'X', apr_pct: 5, tvl_usd: 1e6, daily_rewards_usd: 100,
  ends_at: new Date(NOW + 30 * 86400000).toISOString(), how: ['Lend USDC.'], deposit_url: null,
  protocol: { id: 'safe', name: 'Safe Lend', url: 'https://safe.example', defillama_slug: 'safe-lend' }, tokens: [],
  rewards: [{ symbol: 'RWD', address: '0x' + '11'.repeat(20), verified: true, test: false }], ...extra,
});
const stub = ({ failChain = null } = {}) => {
  merkl.live = async chain => {
    if (chain === failChain) throw new Error('Merkl timeout');
    if (chain !== 'base' && chain !== 'ethereum') return [];
    return chain === 'base' ? [
      C('big'),
      C('lp', { action: 'POOL', apr_pct: 40, tvl_usd: 2e5, protocol: { id: 'dex', name: 'Some Dex', url: 'https://dex.example', defillama_slug: 'hacked-dex' } }),
      C('tiny', { tvl_usd: 1000, apr_pct: 900 }),
      C('zero', { apr_pct: 0 }),
      C('testtoken', { rewards: [{ symbol: 'T', address: '0x' + '22'.repeat(20), verified: false, test: true }] }),
      C('ended', { ends_at: new Date(NOW - 86400000).toISOString() }),
      C('unknown', { protocol: { id: 'new', name: 'Brand New', url: null, defillama_slug: null }, rewards: [{ symbol: 'NEW', address: '0x' + '33'.repeat(20), verified: false, test: false }], ends_at: new Date(NOW + 1.5 * 86400000).toISOString() }),
    ] : [C('eth', { chain: 'ethereum', action: 'BORROW', tvl_usd: 5e6 })];
  };
  llama.protocols = async () => [
    { id: '1', name: 'Safe Lend', slug: 'safe-lend', audit_links: ['https://a'], listed_at: Math.floor(NOW / 1000) - 900 * 86400, tvl_doubted: false, change_7d: 1 },
    { id: '2', name: 'Some Dex', slug: 'hacked-dex', audit_links: [], listed_at: Math.floor(NOW / 1000) - 900 * 86400, tvl_doubted: false, change_7d: 1 },
  ];
  llama.hacks = async () => ({ 2: [{ date: '2023-07-30', amount_usd: 6.1e7, technique: 'Compiler Bug', returned_usd: null }] });
};

test('campaigns: live, with money in them and a real reward; each with what it would cost to take part', async () => {
  stub();
  const r = await opp.campaigns({});
  assert.deepEqual(r.campaigns.map(c => c.id), ['eth', 'big', 'unknown', 'lp'], 'no tiny, zero-rate, test-token or ended campaigns; by money in it');
  const by = Object.fromEntries(r.campaigns.map(c => [c.id, c]));
  assert.deepEqual(by.big.signals.map(s => s.text), ['Safe Lend: No hack recorded; 1 audit link listed']);
  assert.deepEqual(by.lp.signals.map(s => [s.level, s.text]), [
    ['bad', 'Some Dex: Hacked 2023-07-30: $61M lost (Compiler Bug)'],
    ['warn', 'Some Dex: No audit listed'],
    ['warn', 'Providing liquidity: price moves between the two tokens can leave you with less than holding them'],
  ]);
  assert.match(by.eth.signals.map(s => s.text).join(' | '), /Borrowing: if your collateral falls in value, it can be sold \(liquidated\)/);
  assert.deepEqual(by.unknown.signals.map(s => s.text), ['Brand New isn\'t listed on DefiLlama: no hack or audit record to show', 'Reward token not verified by Merkl: NEW', 'Rewards end in 2 days']);
  for (const c of r.campaigns) for (const s of c.signals) assert.ok(s.source, 'every fact names its source');
  assert.deepEqual(by.big.checks, [{ symbol: 'RWD', href: `/safety?chain=base&token=0x${'11'.repeat(20)}` }]);
  assert.equal(by.big.go, 'https://safe.example');
  assert.match(r.note, /on top of the pool's own yield/);
});

test('campaigns: filters, sorting, and a chain that doesn\'t answer', async () => {
  stub({ failChain: 'arbitrum' });
  let r = await opp.campaigns({ sort: 'apr' });
  assert.equal(r.campaigns[0].id, 'lp');
  assert.deepEqual(r.not_checked, [{ check: 'campaigns on Arbitrum', reason: 'Merkl timeout' }]);
  r = await opp.campaigns({ chain: 'base', action: 'POOL' });
  assert.deepEqual(r.campaigns.map(c => c.id), ['lp']);
  r = await opp.campaigns({ sort: 'ending' });
  assert.equal(r.campaigns[0].id, 'unknown', 'ending soonest first');
  merkl.live = async () => { throw new Error('down'); };
  await assert.rejects(opp.campaigns({}), e => e instanceof opp.OpportunitiesRefused && /Merkl didn't answer/.test(e.message));
});

test('input rules', () => {
  assert.match(opp.parseCampaigns({ chain: 'solana' }).error, /chain must be/);
  assert.match(opp.parseCampaigns({ action: 'fly' }).error, /action must be/);
  assert.match(opp.parseCampaigns({ sort: 'x' }).error, /sort must be/);
  assert.deepEqual(opp.parseCampaigns({ action: 'pool', limit: '10' }), { chain: null, action: 'POOL', sort: 'tvl', limit: 10 });
});

test('API and menu: Opportunities stands for itself, Find money and Governance', async t => {
  stub();
  const server = require('../src/app').createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/v1/opportunities/campaigns?chain=base');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /max-age=60/);
  assert.equal((await fetch(base + '/v1/opportunities/campaigns?sort=x')).status, 400);
  for (const p of ['/opportunities', '/find', '/governance']) {
    const html = await (await fetch(base + p)).text();
    assert.ok(html.includes('<a href="/opportunities" aria-current="page">Opportunities</a>'), `${p} is under Opportunities`);
    assert.ok(!/<nav class="nav"[^>]*>.*href="\/find".*<\/nav>/.test(html), 'Find money is no longer its own menu item');
  }
});

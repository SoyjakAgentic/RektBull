/**
 * Research, with DefiLlama, the other desks and Claude as stand-ins: the
 * week boundaries, the hack tracker's totals and techniques, the digest's
 * facts (each with its source, a part that fails named, opportunities
 * included), the writer told to use only those facts and the fact-check
 * that removes what they don't support, the worker drafting it once a week
 * and alerting the owner, and the owner publishing, editing or skipping it:
 * only a published digest is ever shown.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
const ADMIN = '0x' + 'ad'.repeat(20);
Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', ANTHROPIC_API_KEY: 'test', ADMIN_WALLETS: ADMIN, ...(DB ? { DATABASE_URL: DB } : {}) });
const llama = require('../src/providers/llama');
const research = require('../src/services/research');
const claude = require('../src/ai/claude');

const NOW = Date.UTC(2026, 10, 4, 12); // Wednesday 4 November 2026
const H = (date, name, amount, technique, extra) => ({ date, name, amount_usd: amount, returned_usd: null, technique, classification: 'Protocol Logic', chains: ['Ethereum'], bridge: false, target: 'DeFi Protocol', source: null, ...extra });
const HACKS = [
  H('2026-11-01', 'Recent Lend', 4e5, 'Withdrawal Logic Flaw'),
  H('2026-10-29', 'Big Exchange', 6.4e9, 'Key Leaked via Infrastructure', { target: 'CEX' }),
  H('2026-10-27', 'Small Vault', 1e6, 'Withdrawal Logic Flaw', { returned_usd: 5e5 }),
  H('2026-10-20', 'Older Pool', null, 'Oracle Manipulation'),
  H('2026-06-01', 'Last Summer', 2e7, 'Oracle Manipulation'),
];
const stubDesks = ({ failCampaigns = false } = {}) => {
  llama.hackList = async () => HACKS;
  require('../src/services/markets').overview = async () => ({ tvl: { usd: 85e9, change_7d_pct: -0.9 }, dex_volume: { usd_24h: 8.3e9 }, fees: { usd_24h: 6.65e7 }, stablecoins: { usd: 295.2e9, change_7d_pct: -2.1 }, not_checked: [], sources: { tvl: 'DefiLlama TVL', dex_volume: 'DefiLlama DEX volumes', fees: 'DefiLlama fees', stablecoins: 'DefiLlama stablecoins' } });
  require('../src/services/markets').stablecoinList = async () => ({ source: 'DefiLlama stablecoins', stablecoins: [
    { symbol: 'USDT', supply_usd: 178e9, signals: [{ level: 'ok', text: 'On its peg' }] },
    { symbol: 'USDD', supply_usd: 1.5e9, signals: [{ level: 'warn', text: 'Supply down 14% in a week (holders redeeming or leaving)' }] },
  ] });
  require('../src/services/discover').dapps = async () => ({ dapps: [
    { name: 'Falling Bridge', category: 'Bridge', tvl_usd: 5.3e8, change_7d_pct: -16.6 },
    { name: 'Rising Lend', category: 'Lending', tvl_usd: 5.6e9, change_7d_pct: 11.8 },
    { name: 'Flat Dex', category: 'Dexs', tvl_usd: 9e8, change_7d_pct: 1 },
  ] });
  const C = (name, started, extra) => ({ name, chain_name: 'Base', action_label: 'Lend', apr_pct: 2.5, tvl_usd: 4.6e8, started_at: started, signals: [], ...extra });
  require('../src/services/opportunities').campaigns = async () => {
    if (failCampaigns) throw new Error('Merkl didn\'t answer');
    return { total: 197, campaigns: [C('Supply USDC', '2026-09-01T00:00:00.000Z'), C('New Pool', '2026-10-28T10:00:00.000Z', { action_label: 'Provide liquidity', apr_pct: 31, tvl_usd: 6e5, signals: [{ level: 'bad', text: 'Hacked before, $2M lost' }] })] };
  };
  require('../src/yield/rates').listRates = async () => [
    { asset: 'USDC', name: 'Aave', chain_label: 'Base', apy_pct: 4.1, supply_open: true, source: 'Aave v3 onchain' },
    { asset: 'USDC', name: 'Closed Vault', chain_label: 'Base', apy_pct: 9, supply_open: false },
    { asset: 'USDT', name: 'Compound', chain_label: 'Arbitrum', apy_pct: 3.2, supply_open: true },
  ];
  const governors = require('../src/services/governors');
  governors.REGISTRY.splice(0, governors.REGISTRY.length, { chain: 'ethereum', address: '0x' + '11'.repeat(20), name: 'Test DAO' });
  governors.readGovernor = async () => ({ chain: 'ethereum' });
  governors.openProposals = async () => [{ state: 'Active', title: 'Fund the grants program', hours_left: 30, deadline: { at: '2026-11-06T12:00:00.000Z', estimated: true } }, { state: 'Pending', title: 'Not open yet' }];
};

test('lastWeek: the Monday-to-Monday week (UTC) just ended', () => {
  const w = research.lastWeek(new Date(NOW));
  assert.deepEqual([w.start.toISOString().slice(0, 10), w.end.toISOString().slice(0, 10)], ['2026-10-26', '2026-11-02']);
  const monday = research.lastWeek(new Date(Date.UTC(2026, 10, 2, 7)));
  assert.equal(monday.start.toISOString().slice(0, 10), '2026-10-26', 'on a Monday, last week is the one that just ended');
});

test('hack tracker: totals per period, techniques by amount, a filter; unrecorded amounts aren\'t zero', async () => {
  stubDesks();
  const r = await research.hacks({ days: 30 }, NOW);
  assert.deepEqual(r.stats.map(s => [s.days, s.count, s.lost_usd, s.unrecorded]), [[30, 4, 6.4014e9, 1], [90, 4, 6.4014e9, 1], [365, 5, 6.4214e9, 1]]);
  assert.equal(r.stats[0].returned_usd, 5e5);
  assert.deepEqual(r.techniques.map(t => [t.technique, t.count]), [['Key Leaked via Infrastructure', 1], ['Withdrawal Logic Flaw', 2], ['Oracle Manipulation', 1]]);
  assert.deepEqual(r.hacks.map(h => h.name), ['Recent Lend', 'Big Exchange', 'Small Vault', 'Older Pool'], 'newest first');
  const f = await research.hacks({ days: 30, technique: 'Withdrawal Logic Flaw' }, NOW);
  assert.deepEqual(f.hacks.map(h => h.name), ['Recent Lend', 'Small Vault']);
  assert.match(r.note, /never as zero/);
  assert.match(research.parseHacks({ days: '7' }).error, /30, 90, 365 or 3650/);
});

test('the digest\'s facts: each with its source; a part that fails is named', async () => {
  stubDesks({ failCampaigns: true });
  const w = research.lastWeek(new Date(NOW));
  const f = await research.gatherFacts(w.start, w.end);
  const texts = f.items.map(i => i.text);
  assert.equal(texts[0], '3 exploits recorded, $6.4B lost in all', 'the week\'s hacks only (26 Oct to 2 Nov)');
  assert.ok(texts.includes('Small Vault (2026-10-27): $1M lost, Withdrawal Logic Flaw; $500K returned; Ethereum'));
  assert.ok(texts.includes('USDD ($1.5B supply): Supply down 14% in a week (holders redeeming or leaving)'));
  assert.ok(!texts.some(t => t.startsWith('USDT')), 'a stablecoin on its peg isn\'t news');
  assert.ok(texts.includes('Falling Bridge (Bridge): TVL $530M, down 16.6% on the week'));
  assert.ok(texts.includes('Rising Lend (Lending): TVL $5.6B, up 11.8% on the week'));
  assert.ok(!texts.some(t => t.startsWith('Flat Dex')), 'a small move isn\'t news');
  assert.ok(texts.includes('Highest USDC supply rate among the venues RektBull reads: Aave on Base, 4.1% a year (it changes with demand)'), 'a venue closed to deposits isn\'t the best rate');
  assert.ok(texts.includes('Test DAO vote open: "Fund the grants program", closing 2026-11-06 (estimated)'));
  assert.ok(!texts.some(t => t.includes('Not open yet')));
  for (const i of f.items) assert.ok(i.source, `"${i.text}" names its source`);
  assert.deepEqual(f.not_checked, [{ check: 'reward campaigns', reason: 'Merkl didn\'t answer' }]);

  stubDesks();
  const o = (await research.gatherFacts(w.start, w.end)).items.filter(i => i.section === 'Opportunities').map(i => i.text);
  assert.equal(o[0], '197 live reward campaigns with $50K or more in them on RektBull\'s six chains, 1 of them started this week');
  assert.equal(o[1], 'New: New Pool (Base, provide liquidity): 31% extra rewards a year, $600K in it. Note: Hacked before, $2M lost.', 'a bad signal goes with it');
  assert.equal(o[2], 'Supply USDC (Base, lend): 2.5% extra rewards a year, $460M in it.');
});

test('the writer is told to use only the facts, cite them, and never predict or recommend; the fact-check removes what they don\'t support', async () => {
  assert.match(research.SYSTEM, /Use only the facts given\. Never add a fact/);
  assert.match(research.SYSTEM, /put its source in brackets/);
  assert.match(research.SYSTEM, /Never predict prices or outcomes, never recommend/);
  assert.match(research.CHECK_SYSTEM, /remove:[\s\S]*the facts don't support[\s\S]*predicts, recommends/);
  assert.equal(research.BYLINE, 'Written by RektBull Research');

  const facts = { week_start: '2026-10-26', week_end: '2026-11-02', items: [{ section: 'Hacks', text: '3 exploits', source: 'DefiLlama hacks' }], not_checked: [] };
  const calls = [];
  claude.available = () => true;
  claude.write = async ({ system, prompt }) => {
    calls.push({ system, prompt });
    return calls.length === 1 ? { text: '## Hacks\n3 exploits [DefiLlama hacks]. Expect more next week.' }
      : { text: '## Hacks\n3 exploits [DefiLlama hacks].\n=== REMOVED ===\n- Expect more next week.' };
  };
  const r = await research.draftAndCheck(facts);
  assert.equal(calls[1].system, research.CHECK_SYSTEM);
  assert.match(calls[1].prompt, /- Hacks \| 3 exploits \| DefiLlama hacks[\s\S]*Draft:\n## Hacks\n3 exploits \[DefiLlama hacks\]\. Expect more/, 'the checker gets the facts and the draft');
  assert.equal(r.checked, '## Hacks\n3 exploits [DefiLlama hacks].');
  assert.deepEqual(r.notes, [{ step: 'fact-check', removed: 'Expect more next week.' }]);

  claude.write = async ({ system }) => ({ text: system === research.SYSTEM ? 'A draft [DefiLlama hacks].' : 'no marker here' });
  const unchecked = await research.draftAndCheck(facts);
  assert.equal(unchecked.checked, null);
  assert.equal(unchecked.draft, 'A draft [DefiLlama hacks].');
  assert.match(unchecked.notes[0].reason, /fact-check couldn't run.*review the draft closely/);

  claude.available = () => false;
  assert.match((await research.draftAndCheck(facts)).notes[0].reason, /No AI is set up.*the facts can be published alone/);
});

test('digests: drafted once a week and the owner alerted; published, edited or skipped by the owner; only published ones shown', { skip: !DB && 'set TEST_DATABASE_URL' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  stubDesks();
  const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [ADMIN]);
  const { rows: [other] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', ['0x' + 'bb'.repeat(20)]);
  const prompts = [];
  claude.write = async ({ system, prompt }) => {
    prompts.push({ system, prompt });
    return system === research.SYSTEM ? { text: '## The week in brief\nThree exploits were recorded [DefiLlama hacks].' } : { text: `${prompt.split('Draft:\n')[1]}\n=== REMOVED ===\n- none` };
  };
  claude.available = () => true;

  assert.equal(await research.tick(new Date(Date.UTC(2026, 10, 2, 5))), null, 'not before Monday 06:00 UTC');
  const made = await research.tick(new Date(Date.UTC(2026, 10, 2, 7)));
  assert.equal(made.week_start, '2026-10-26');
  assert.equal(made.status, 'draft');
  assert.match(made.checked, /Three exploits/);
  assert.deepEqual(made.check_notes, []);
  assert.equal(made.model, undefined, 'no model named anywhere');
  assert.match(prompts[0].prompt, /- Hacks \| 3 exploits recorded, \$6\.4B lost in all \| DefiLlama hacks/, 'the facts and their sources go to the AI, nothing else');
  assert.equal(prompts.length, 2, 'the writer, then the fact-check');
  assert.equal(await research.tick(new Date(Date.UTC(2026, 10, 3, 9))), null, 'once a week');
  assert.equal(prompts.length, 2);
  const { rows: alerts } = await db.query('SELECT account_id, kind, title FROM monitor_alerts');
  assert.deepEqual(alerts, [{ account_id: acct.id, kind: 'digest_draft', title: 'Weekly digest ready for review: week of 2026-10-26' }], 'the owner, and only the owner, is alerted');
  const m = require('../src/alerts/format').message({ ...alerts[0], detail: { reasons: [{ text: 'Read it', source: 'x' }] } });
  assert.deepEqual([m.url.endsWith('/research#review'), m.action], [true, 'Review and publish']);

  claude.available = () => false;
  const plain = await research.makeDigest({ start: new Date(Date.UTC(2026, 9, 19)), end: new Date(Date.UTC(2026, 9, 26)) });
  assert.equal(plain.checked, null, 'no AI: nothing written');

  const server = require('../src/app').createApp().listen(0);
  t.after(async () => { server.close(); await db.getPool().end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p, token) => { const r = await fetch(base + p, { headers: token ? { authorization: `Bearer ${token}` } : {} }); return { status: r.status, body: await r.json() }; };
  const post = async (p, token, body = {}) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const siwe = require('../src/auth/siwe');
  const owner = siwe.issueToken(acct), stranger = siwe.issueToken(other);

  assert.deepEqual((await get('/v1/research/digests')).body.digests, [], 'drafts are never shown');
  assert.equal((await get('/v1/research/digests/latest')).status, 404);
  assert.equal((await get('/v1/research/digests/2026-10-26')).status, 404);

  assert.equal((await get('/v1/admin/research/drafts', stranger)).status, 403, 'only the owner reviews');
  const review = (await get('/v1/admin/research/drafts', owner)).body;
  assert.deepEqual(review.drafts.map(d => d.week_start), ['2026-10-26', '2026-10-19']);
  assert.deepEqual(review.newsletter, { confirmed: 0, pending: 0 });
  assert.equal(review.newsletter_ready, false);

  assert.equal((await post('/v1/admin/research/digests/2026-10-26/publish', stranger)).status, 403);
  assert.equal((await post('/v1/admin/research/digests/2026-10-28/publish', owner)).status, 400, 'a week starts on a Monday');
  const edited = '## The week in brief\nThree exploits were recorded, $6.4B lost in all [DefiLlama hacks].';
  const pub = await post('/v1/admin/research/digests/2026-10-26/publish', owner, { text: edited });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.text, edited, 'the owner\'s edit is what\'s published');
  assert.equal(pub.body.byline, 'Written by RektBull Research');
  assert.equal((await post('/v1/admin/research/digests/2026-10-26/publish', owner)).status, 409, 'once');
  assert.equal((await post('/v1/admin/research/digest', owner, { week_start: '2026-10-26' })).status, 409, 'a published week isn\'t redrafted');
  assert.equal((await post('/v1/admin/research/digests/2026-10-19/publish', owner, { text: null })).body.text, null, 'or the facts alone');

  const shown = (await get('/v1/research/digests')).body.digests;
  assert.deepEqual(shown.map(d => [d.week_start, d.written]), [['2026-10-26', true], ['2026-10-19', false]]);
  const latest = (await get('/v1/research/digests/latest')).body;
  assert.equal(latest.week_start, '2026-10-26');
  assert.equal(latest.draft, undefined, 'the public never sees the draft');
  assert.ok(latest.published_at);
  assert.match((await get('/v1/research/digests/2026-10-19')).body.note, /The facts for the week, each with its source/);
  assert.equal((await get('/v1/research/digests/2026-01-05')).status, 404);
  assert.equal((await get('/v1/research/digests/nope')).status, 400);
  assert.equal((await get('/v1/research/hacks?days=90')).status, 200);

  assert.equal((await post('/v1/admin/research/digest', stranger, {})).status, 403, 'only the owner drafts');
  assert.equal((await post('/v1/admin/research/digest', owner, { week_start: '2026-10-12' })).body.status, 'draft');
  assert.equal((await post('/v1/admin/research/digests/2026-10-12/skip', owner)).body.status, 'skipped');
  assert.equal((await post('/v1/admin/research/digests/2026-10-12/skip', owner)).status, 404, 'only a draft is skipped');
  assert.equal((await get('/v1/research/digests/2026-10-12')).status, 404, 'a skipped week is never shown');
  assert.deepEqual((await get('/v1/admin/research/drafts', owner)).body.drafts, []);
});

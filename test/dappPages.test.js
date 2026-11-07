/**
 * Protocol record pages, with DefiLlama and Merkl as stand-ins: which
 * protocols get a page ($10M or more), the opening answer built from the
 * record, the question "is it safe?" answered with the record and never with
 * "yes", hacks with their sources, a hack record that couldn't be read said
 * so, escaping, links only to https, titles that fit, FAQ and breadcrumb
 * data, the index, the sitemap, and Discover linking to the records.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: '', PUBLIC_URL: 'https://rektbull.test' });
const llama = require('../src/providers/llama');
const dappPage = require('../src/pages/dappPage');

const NOW = Date.UTC(2026, 10, 7, 12);
const P = (slug, name, tvl, extra = {}) => ({ id: extra.id || slug, name, slug, category: 'Lending', chains: ['ethereum', 'base'], chain_count: 2, tvl, chain_tvl: {}, change_1d: 0, change_7d: 3.7, audit_links: ['https://audits.example/1'], listed_at: Date.UTC(2022, 3, 1) / 1000, url: 'https://lend.example', logo: null, token: { chain: 'ethereum', address: '0x' + '44'.repeat(20) }, tvl_doubted: false, ...extra });
const PROTOCOLS = [
  P('big-lend', 'Big Lend', 15.8e9, { chain_count: 21 }),
  P('hacked-vault', 'Hacked Vault', 50e6, { id: '77', category: 'Yield' }),
  P('other-lend', 'Other Lend', 2e9),
  P('weird', '<script>alert(1)</script> Finance', 20e6, { audit_links: ['javascript:alert(1)', 'https://ok.example/a'], url: 'javascript:alert(2)' }),
  P('tiny', 'Tiny Thing', 2e6),
  P('Bad Slug!', 'Bad Slug', 30e6),
  P('a-protocol-with-a-really-quite-long-name', 'A Protocol With A Really Quite Long Name Indeed', 12e6),
];
const HACKS = [
  { date: '2026-03-12', name: 'Hacked Vault', amount_usd: 862000, returned_usd: 862000, technique: 'Oracle Misconfiguration', classification: 'Protocol Logic', chains: ['Ethereum'], source: 'https://postmortem.example/hv', defillama_id: '77' },
  { date: '2024-01-02', name: 'Hacked Vault', amount_usd: 5e6, returned_usd: null, technique: 'Flash Loan', classification: null, chains: [], source: 'javascript:alert(3)', defillama_id: '77' },
  { date: '2025-05-05', name: 'Someone Else', amount_usd: 1e6, defillama_id: '99' },
];
let hacksDown = false;
llama.protocols = async () => PROTOCOLS;
llama.fees = async () => ({ protocols: { 'big-lend': { total: 1.1e6 } } });
llama.hackList = async () => { if (hacksDown) throw new Error('DefiLlama didn\'t answer'); return HACKS; };
llama.hacks = async () => ({});
require('../src/services/opportunities').campaigns = async () => ({ total: 2, campaigns: [{ name: 'Supply USDC', protocol: { defillama_slug: 'big-lend' } }, { name: 'Other', protocol: { defillama_slug: 'other' } }] });

let server, base;
test.before(() => { server = require('../src/app').createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const get = async p => { const r = await fetch(base + p, { headers: { accept: 'text/html' } }); return { status: r.status, body: await r.text(), cache: r.headers.get('cache-control') }; };
const graph = html => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(m => { const d = JSON.parse(m[1]); return d['@graph'] || [d]; });

test('which protocols get a page: $10M or more locked, a clean slug, ranked', () => {
  const e = dappPage.eligible(PROTOCOLS);
  assert.deepEqual(e.map(p => [p.slug, p.rank]), [['big-lend', 1], ['other-lend', 2], ['hacked-vault', 3], ['weird', 4], ['a-protocol-with-a-really-quite-long-name', 5]]);
  assert.equal(dappPage.title('Big Lend'), 'Is Big Lend Safe? Hacks, Audits and Record | RektBull');
  for (const p of e) assert.ok(dappPage.title(p.name).length <= 60, p.name);
  assert.equal(dappPage.title('A Protocol With A Really Quite Long Name Indeed'), 'A Protocol With A Really Quite Long…: Record | RektBull');
});

test('a record page: the answer from the record, the facts with sources, never "safe"', async () => {
  const { status, body, cache } = await get('/dapps/hacked-vault');
  assert.equal(status, 200);
  assert.match(cache, /max-age=600/);
  assert.match(body, /<title>Is Hacked Vault Safe\? Hacks, Audits and Record \| RektBull<\/title>/);
  assert.match(body, /<meta name="description" content="Hacked Vault&#39;s record: \$50M locked, 2 hacks recorded, 1 audit listed\. Every fact with its source; not advice\.">/);
  assert.match(body, /<link rel="canonical" href="https:\/\/rektbull\.test\/dapps\/hacked-vault">/);
  assert.match(body, /Hacked Vault is a Yield protocol on Ethereum, Base, with \$50M locked \(up 3\.7% on the week\), listed on DefiLlama since 1 April 2022 \(4 years\)\. DefiLlama records 2 hacks affecting Hacked Vault, with \$5\.9M lost in all; the most recent was on 12 March 2026\./);
  assert.match(body, /<a href="https:\/\/postmortem\.example\/hv" rel="nofollow noopener" target="_blank">Write-up<\/a>/, 'a hack\'s source, linked');
  assert.ok(!body.includes('javascript:'), 'never a non-https link');
  assert.match(body, /<span class="sig bad"[^>]*>Hacked 2026-03-12: \$862K lost \(Oracle Misconfiguration\), \$862K returned<\/span>/);
  assert.match(body, /Fees in the last 24 hours<\/th><td>not recorded/);
  assert.match(body, /<a href="\/safety\?chain=ethereum&amp;token=0x4444/, 'a link to check its token');
  assert.match(body, /Facts from DefiLlama and Merkl, each with its source\. A record is never proof that a protocol is safe\./, 'its own footer note');

  const faq = graph(body).find(x => x['@type'] === 'FAQPage');
  assert.deepEqual(faq.mainEntity.map(q => q.name), ['Is Hacked Vault safe?', 'Has Hacked Vault been hacked?', 'How much is locked in Hacked Vault?', 'Has Hacked Vault been audited?']);
  const safe = faq.mainEntity[0].acceptedAnswer.text;
  assert.match(safe, /^No check can say a protocol is safe\. What the record shows:/);
  assert.ok(!/\b(is|are) safe\b(?! ?\?)/i.test(safe.replace('No check can say a protocol is safe', '')), 'the answer never calls it safe');
  assert.match(faq.mainEntity[1].acceptedAnswer.text, /^Yes: DefiLlama records 2 hacks: 2026-03-12, \$862K lost \(Oracle Misconfiguration\); 2024-01-02, \$5M lost \(Flash Loan\)\./);
  assert.deepEqual(graph(body).find(x => x['@type'] === 'BreadcrumbList').itemListElement.map(i => i.name), ['Home', 'Discover', 'Protocol records', 'Hacked Vault']);
  assert.equal(graph(body).find(x => x['@type'] === 'WebPage').about.sameAs[0], 'https://defillama.com/protocol/hacked-vault');
});

test('no hack recorded, campaigns, related protocols, and a hack record that couldn\'t be read', async () => {
  const big = (await get('/dapps/big-lend')).body;
  assert.match(big, /on Ethereum, Base and 19 more chains/, 'the chains RektBull names, then the count of the rest');
  assert.match(big, /DefiLlama records no hack affecting Big Lend\./);
  assert.match(big, /DefiLlama's record shows no hack affecting Big Lend\. That's the public record, not a guarantee/);
  assert.match(big, /Fees in the last 24 hours<\/th><td>\$1\.1M/);
  assert.match(big, /1 live reward campaign on Big Lend right now/);
  assert.match(big, /<a href="\/dapps\/other-lend">Other Lend<\/a> \(\$2B\)/, 'related protocols, linked');
  assert.match(big, /#1 of the 5 protocols with \$10M or more/);

  hacksDown = true;
  try {
    const down = (await get('/dapps/big-lend')).body;
    assert.match(down, /The hack record couldn&#39;t be read just now/);
    assert.match(down, /Not checked: recorded hacks \(DefiLlama didn&#39;t answer\)\./);
    assert.ok(!/records no hack/.test(down), 'never "no hack" when the record wasn\'t read');
  } finally { hacksDown = false; }
});

test('escaping, small and unknown protocols, the index, the sitemap and Discover\'s links', async () => {
  const weird = (await get('/dapps/weird')).body;
  assert.ok(!weird.includes('<script>alert'), 'a protocol\'s name is never read as markup');
  assert.match(weird, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Finance/);
  assert.match(weird, /<a href="https:\/\/ok\.example\/a" rel="nofollow noopener" target="_blank">Audit 2<\/a>/);
  assert.ok(!weird.includes('javascript:'));
  assert.ok(!weird.includes('Its site:'), 'a site that isn\'t https isn\'t linked');
  for (const slug of ['tiny', 'no-such-protocol', 'Bad%20Slug!']) assert.equal((await get(`/dapps/${slug}`)).status, 404, slug);

  const index = (await get('/dapps')).body;
  assert.match(index, /<title>DeFi Protocol Records: Hacks, Audits, TVL \| RektBull<\/title>/);
  assert.match(index, /Every DeFi protocol with \$10M or more locked \(5 of them\)/);
  assert.match(index, /<h2>Lending <span class="muted small">\(4\)<\/span><\/h2>/);
  assert.ok(index.indexOf('Big Lend') < index.indexOf('Other Lend'), 'largest first');
  assert.equal(graph(index).find(x => x['@type'] === 'CollectionPage').url, 'https://rektbull.test/dapps');

  const sitemap = (await get('/sitemap.xml')).body;
  for (const slug of ['big-lend', 'hacked-vault', 'weird']) assert.match(sitemap, new RegExp(`<loc>https://rektbull\\.test/dapps/${slug}</loc>`));
  assert.match(sitemap, /<loc>https:\/\/rektbull\.test\/dapps<\/loc>/);
  assert.ok(!sitemap.includes('/dapps/tiny'));
  assert.match((await get('/llms.txt')).body, /\[Protocol records\]\(https:\/\/rektbull\.test\/dapps\)/);

  const discover = require('../src/services/discover');
  const rows = (await discover.dapps({ limit: 10 })).dapps;
  assert.equal(rows.find(r => r.name === 'Big Lend').links.record, '/dapps/big-lend');
  assert.equal(rows.find(r => r.name === 'Tiny Thing').links.record, null, 'no record page, no link to one');
});

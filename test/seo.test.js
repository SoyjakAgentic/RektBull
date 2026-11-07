/**
 * What search engines, AI assistants and link previews see: every page's
 * title and description (unique, and short enough to show whole), one
 * canonical address, preview tags and image, structured data (who RektBull
 * is, breadcrumbs, and FAQ data matching the questions each page shows),
 * the server-rendered "At a glance" facts (and a page that never waits for
 * them), robots.txt welcoming AI crawlers, the sitemap, llms.txt, the About
 * page, IndexNow, one address per page, and a real 404.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: '', PUBLIC_URL: 'https://rektbull.test', OPERATOR_NAME: 'Test Operator Ltd', PRIVACY_CONTACT: 'hello@rektbull.test', SAME_AS: 'https://x.com/rektbull, not-a-url' });
const seo = require('../src/pages/seo');
const glance = require('../src/pages/glance');

// The data behind "At a glance", stood in for (no network in tests).
const stand = {
  hacks: async () => ({ source: 'DefiLlama hacks', stats: [{ days: 30, lost_usd: 6.4e9, count: 3, unrecorded: 1, returned_usd: 5e5 }, { days: 90, lost_usd: 6.5e9, count: 4, unrecorded: 1 }, { days: 365, lost_usd: 7e9, count: 9, unrecorded: 2 }], techniques: [{ technique: 'Key Leaked via Infrastructure', lost_usd: 6.4e9, count: 1 }] }),
  overview: async () => ({ tvl: { usd: 85e9, change_7d_pct: -0.9 }, dex_volume: { usd_24h: 8.3e9 }, stablecoins: { usd: 295e9, change_7d_pct: 0.4 }, sources: { tvl: 'DefiLlama TVL', dex_volume: 'DefiLlama DEX volumes', stablecoins: 'DefiLlama stablecoins' } }),
  stablecoinList: async () => ({ source: 'DefiLlama stablecoins', stablecoins: [{ symbol: 'USDT', signals: [{ level: 'ok' }] }, { symbol: 'USDD', signals: [{ level: 'warn' }] }] }),
  x402: async () => ({ total: 211, read: { endpoints: 500, listed: 114274 }, source: 'Coinbase x402 Bazaar', services: [{ name: 'Search Co', payers_30d: 300 }, { name: 'X Pay', payers_30d: 257 }] }),
  dapps: async () => ({ total: 4000, dapps: [{ name: 'Aave', tvl_usd: 3e10 }, { name: 'Lido', tvl_usd: 2.5e10 }] }),
};
require('../src/services/research').hacks = (...a) => stand.hacks(...a);
require('../src/services/markets').overview = (...a) => stand.overview(...a);
require('../src/services/markets').stablecoinList = (...a) => stand.stablecoinList(...a);
require('../src/services/agents').x402Services = (...a) => stand.x402(...a);
require('../src/services/discover').dapps = (...a) => stand.dapps(...a);
require('../src/providers/llama').protocols = async () => []; // no protocol records here (test/dappPages.test.js covers them)

let server, base;
test.before(() => { server = require('../src/app').createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const get = async (p, headers = {}) => { const r = await fetch(base + p, { redirect: 'manual', headers }); return { status: r.status, type: r.headers.get('content-type') || '', location: r.headers.get('location'), body: await r.text() }; };
const one = (html, re) => { const m = [...html.matchAll(re)]; assert.equal(m.length, 1, `${re} appears once`); return m[0][1]; };
const ld = html => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
const graph = html => ld(html).flatMap(d => d['@graph'] || [d]);

test('every page: a title and description that show whole, unique, with one canonical and preview tags', async () => {
  const titles = new Set(); const descriptions = new Set();
  for (const route of Object.keys(seo.PAGES)) {
    const { status, body } = await get(route);
    assert.equal(status, 200, route);
    const title = one(body, /<title>([^<]*)<\/title>/g);
    const description = one(body, /<meta name="description" content="([^"]*)">/g).replace(/&#39;/g, "'");
    assert.ok(title.length <= 60, `${route}: title is ${title.length} characters`);
    assert.ok(description.length >= 70 && description.length <= 160, `${route}: description is ${description.length} characters`);
    assert.match(title, /RektBull/);
    titles.add(title); descriptions.add(description);
    assert.equal(one(body, /<link rel="canonical" href="([^"]*)">/g), `https://rektbull.test${route}`);
    assert.equal(one(body, /<meta property="og:url" content="([^"]*)">/g), `https://rektbull.test${route}`);
    assert.equal(one(body, /<meta property="og:image" content="([^"]*)">/g), 'https://rektbull.test/og.png');
    assert.match(body, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(body, /<link rel="icon" href="\/favicon.svg"/);
    assert.ok(!body.includes('<!--#'), `${route}: every placeholder filled`);
    assert.equal((body.match(/<h1[\s>]/g) || []).length, 1, `${route}: one h1`);
  }
  assert.equal(titles.size, Object.keys(seo.PAGES).length, 'titles are unique');
  assert.equal(descriptions.size, Object.keys(seo.PAGES).length, 'descriptions are unique');
});

test('structured data: who RektBull is, each page\'s place, and FAQ data that matches the questions shown', async () => {
  const home = (await get('/')).body;
  const h = graph(home);
  assert.deepEqual(h.map(x => x['@type']), ['Organization', 'WebSite', 'FAQPage']);
  assert.equal(h[0].logo, 'https://rektbull.test/icon-512.png');
  assert.deepEqual(h[0].sameAs, ['https://x.com/rektbull'], 'official profiles from SAME_AS; anything not https is dropped');
  assert.ok(h[2].mainEntity.length >= 5, 'the home page\'s own FAQ, as data');

  const find = graph((await get('/find')).body);
  const crumbs = find.find(x => x['@type'] === 'BreadcrumbList').itemListElement.map(i => [i.position, i.name, i.item]);
  assert.deepEqual(crumbs, [[1, 'Home', 'https://rektbull.test/'], [2, 'Opportunities', 'https://rektbull.test/opportunities'], [3, 'Find money', 'https://rektbull.test/find']]);
  assert.equal(find.find(x => x['@type'] === 'WebPage').url, 'https://rektbull.test/find');

  for (const [route, qs] of Object.entries(seo.FAQ)) {
    const body = (await get(route)).body;
    const shown = [...body.matchAll(/<details><summary>([^<]*)<\/summary>/g)].map(m => m[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    const faq = graph(body).find(x => x['@type'] === 'FAQPage');
    assert.deepEqual(faq.mainEntity.map(q => q.name), shown, `${route}: the data is the questions shown`);
    assert.deepEqual(shown, qs.map(([q]) => q));
    for (const q of faq.mainEntity) assert.ok(!/<[a-z]/i.test(q.acceptedAnswer.text), `${route}: answers as plain text`);
    assert.match(body, /<section class="card" id="questions">[\s\S]*<\/section>\s*<\/main>/, `${route}: the questions end the page's main content`);
  }
  for (const html of [home, (await get('/safety')).body]) assert.ok(!/<\/script>[^<]*<\/script>/.test(html) && ld(html).length >= 1);
});

test('the About page: who runs it, how the checks work, every source', async () => {
  const { status, body } = await get('/about');
  assert.equal(status, 200);
  assert.match(body, /RektBull is run by Test Operator Ltd/);
  assert.match(body, /mailto:hello@rektbull\.test/);
  for (const id of ['how', 'sources', 'digest', 'really-us']) assert.match(body, new RegExp(`id="${id}"`));
  for (const source of ['GoPlus', 'DefiLlama', 'Merkl', 'Snapshot', 'Etherscan', 'x402 Bazaar', 'Anthropic']) assert.match(body, new RegExp(source));
  const g = graph(body);
  assert.equal(g.find(x => x['@type'] === 'AboutPage').publisher.name, 'RektBull');
  assert.ok(!body.includes('{{'), 'every placeholder filled');
  assert.match((await get('/')).body, /<a href="\/about">About and sources<\/a>/, 'linked from every footer');
});

test('"At a glance": facts rendered on the server with their sources; a slow or failing source never holds a page up', async () => {
  glance.clear();
  const research = (await get('/research')).body;
  assert.match(research, /<section class="card glance"[\s\S]*In the last 30 days: \$6\.4B lost in 3 recorded hacks \(1 with no amount recorded\); \$500K returned\. <span class="source">DefiLlama hacks<\/span>/);
  assert.match(research, /The costliest way in over 90 days: Key Leaked via Infrastructure, \$6\.4B across 1 hack\./);
  assert.match(research, /As of \d{1,2} \w+ \d{4}, \d{2}:\d{2} UTC\./);
  assert.match((await get('/markets')).body, /Money locked in DeFi: \$85B, down 0\.9% on the week\. <span class="source">DefiLlama TVL<\/span>[\s\S]*1 stablecoin flagged \(off peg by over 0\.5%, or supply down 10% in a week\): USDD\./);
  assert.match((await get('/agents')).body, /211 x402 services had 5 or more different payers in the last 30 days, from the busiest 500 of 114,274 listed endpoints\./);
  assert.match((await get('/discover')).body, /Largest dapps by money locked: Aave \(\$30B\), Lido \(\$25B\)\./);
  assert.ok(!(await get('/safety')).body.includes('glance'), 'only on data pages');

  glance.clear();
  stand.overview = async () => { throw new Error('DefiLlama didn\'t answer'); };
  const failed = (await get('/markets')).body;
  assert.ok(!failed.includes('class="card glance"') && !failed.includes('<!--#facts-->'), 'no block, and no placeholder left');

  glance.clear();
  stand.dapps = () => new Promise(r => setTimeout(() => r({ total: 1, dapps: [] }), 4000));
  const t0 = Date.now();
  const slow = await get('/discover');
  assert.equal(slow.status, 200);
  assert.ok(Date.now() - t0 < 3000, `served without waiting (${Date.now() - t0} ms)`);
  assert.ok(!slow.body.includes('class="card glance"'));
});

test('robots.txt, the sitemap, the icons and the preview image', async () => {
  const robots = await get('/robots.txt');
  assert.match(robots.type, /text\/plain/);
  assert.ok(!/Disallow/.test(robots.body), 'nothing blocked: the pages fetch /v1 as they render');
  for (const bot of ['*', 'GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended']) assert.match(robots.body, new RegExp(`^User-agent: ${bot.replace('*', '\\*')}$`, 'm'), `${bot} welcome`);
  assert.match(robots.body, /^Allow: \/$/m);
  assert.match(robots.body, /^Sitemap: https:\/\/rektbull\.test\/sitemap\.xml$/m);
  const llms = await get('/llms.txt');
  assert.match(llms.type, /text\/plain/);
  assert.match(llms.body, /^# RektBull\n\n> Crypto safety and AI agents: free checks/);
  for (const route of Object.keys(seo.PAGES)) assert.ok(llms.body.includes(`(https://rektbull.test${route})`), `llms.txt links ${route}`);
  assert.match(llms.body, /\[MCP server\]\(https:\/\/rektbull\.test\/mcp\)/);
  assert.match(llms.body, /\[OpenAPI\]\(https:\/\/rektbull\.test\/v1\/openapi\.json\)/);
  assert.match((await get('/')).body, /<link rel="preload" href="\/fonts\/bricolage\.woff2" as="font" type="font\/woff2" crossorigin>/);
  assert.match((await fetch(`${base}/site.css`)).headers.get('cache-control'), /max-age=600/);
  const map = await get('/sitemap.xml');
  assert.match(map.type, /application\/xml/);
  const locs = [...map.body.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
  assert.deepEqual(locs, [...Object.keys(seo.PAGES), ...require('../src/pages/agentPage').list().map(x => `/agents/${x.slug}`)].map(r => `https://rektbull.test${r}`), 'every page, then each AI agent\'s page');
  assert.ok(!locs.some(l => l.endsWith('/404')));
  for (const f of ['favicon.svg', 'favicon-48.png', 'apple-touch-icon.png', 'icon-512.png', 'og.png']) {
    assert.equal((await fetch(`${base}/${f}`)).status, 200, f);
  }
  const og = fs.readFileSync(path.join(__dirname, '..', 'public', 'og.png'));
  assert.deepEqual([og.readUInt32BE(16), og.readUInt32BE(20)], [1200, 630], 'the preview image is 1200 by 630');
  assert.deepEqual([(await get('/favicon.ico')).status, (await get('/favicon.ico')).location], [301, '/favicon-48.png']);
});

test('one address per page, and a real 404', async () => {
  for (const [file, route] of [['/safety.html', '/safety'], ['/home.html', '/'], ['/privacy.html', '/privacy'], ['/agents.html', '/agents']]) {
    const r = await get(file);
    assert.deepEqual([r.status, r.location], [301, route], file);
  }
  for (const template of ['/digest.html', '/404.html']) assert.equal((await get(template, { accept: 'text/html' })).status, 404, `${template} is a template, not a page`);
  assert.equal((await get('/research/2026-10-26', { accept: 'text/html' })).status, 404, 'no digest pages without a database');
  const page = await get('/no-such-page', { accept: 'text/html' });
  assert.equal(page.status, 404);
  assert.match(page.body, /<meta name="robots" content="noindex">/);
  assert.match(page.body, /Nothing here/);
  const api = await get('/v1/no-such-thing', { accept: 'text/html' });
  assert.deepEqual([api.status, JSON.parse(api.body)], [404, { error: 'not_found' }], 'the API answers JSON');
  assert.deepEqual(JSON.parse((await get('/no-such-page')).body), { error: 'not_found' }, 'a client that doesn\'t ask for HTML gets JSON');
});

test('IndexNow: the key proves the site, and a published digest is pinged; nothing without a key or https', async () => {
  const env = require('../src/config/env');
  const indexnow = require('../src/services/indexnow');
  const axios = require('axios');
  const sent = [];
  const post = axios.post;
  axios.post = async (url, body) => { sent.push({ url, body }); return { data: {} }; };
  try {
    assert.deepEqual(await indexnow.ping(['/research/2026-10-26']), { sent: false, reason: 'INDEXNOW_KEY is not set' });
    assert.equal((await get('/0123456789abcdef0123456789abcdef.txt')).status, 404);
    env.indexNowKey = '0123456789abcdef0123456789abcdef';
    const key = await get('/0123456789abcdef0123456789abcdef.txt');
    assert.deepEqual([key.status, key.body], [200, '0123456789abcdef0123456789abcdef']);
    assert.equal((await get('/someone-else.txt')).status, 404);
    assert.equal((await indexnow.ping(['/research/2026-10-26', '/research'])).sent, true);
    assert.deepEqual(sent, [{ url: 'https://api.indexnow.org/indexnow', body: { host: 'rektbull.test', key: '0123456789abcdef0123456789abcdef', keyLocation: 'https://rektbull.test/0123456789abcdef0123456789abcdef.txt', urlList: ['https://rektbull.test/research/2026-10-26', 'https://rektbull.test/research'] } }]);
    env.indexNowKey = 'bad key!';
    assert.equal((await indexnow.ping(['/research'])).sent, false, 'a malformed key is never used');
  } finally {
    axios.post = post;
    env.indexNowKey = '';
  }
});

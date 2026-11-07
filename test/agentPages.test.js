/**
 * One page per AI agent (/agents/<slug>), and the identity "crypto safety and
 * AI agents": each page's title and description fit, its facts match the
 * agents' own catalog, every check names a source, it never calls anything
 * safe or promises returns, FAQ, breadcrumb and SoftwareApplication data, the
 * links between pages, the sitemap, llms.txt, the home page and About.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: '', PUBLIC_URL: 'https://rektbull.test' });
require('../src/providers/llama').protocols = async () => [];
const agentPage = require('../src/pages/agentPage');
const { catalog } = require('../src/services/myAgents');

let server, base;
test.before(() => { server = require('../src/app').createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const get = async p => { const r = await fetch(base + p, { headers: { accept: 'text/html' } }); return { status: r.status, body: await r.text() }; };
const graph = html => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(m => { const d = JSON.parse(m[1]); return d['@graph'] || [d]; });
const plain = html => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('a page for each of the seven agents, written for a real search', async () => {
  assert.deepEqual(agentPage.list().map(a => a.slug), ['wallet-checkup', 'wallet-guardian', 'claim-assistant', 'token-watch', 'dao-votes', 'yield-watch', 'trading-agent']);
  const titles = new Set();
  for (const { id, slug } of agentPage.list()) {
    const p = agentPage.PAGES[id];
    const c = catalog().find(x => x.id === id);
    assert.ok(p.title.length <= 60 && p.title.endsWith(' | RektBull'), `${slug} title fits`);
    assert.ok(p.description.length >= 70 && p.description.length <= 160, `${slug} description fits (${p.description.length})`);
    assert.ok(!titles.has(p.title)); titles.add(p.title);
    assert.ok(p.checks.every(([, src]) => src.length > 3), `${slug}: every check names its source`);

    const { status, body } = await get(`/agents/${slug}`);
    assert.equal(status, 200, slug);
    assert.match(body, new RegExp(`<link rel="canonical" href="https://rektbull\\.test/agents/${slug}">`));
    assert.ok(body.includes(`<h1>${c.name}:`), `${slug}: named in the heading`);
    const text = plain(body);
    assert.ok(text.includes(c.does), `${slug}: what it does, from the catalog`);
    assert.ok(text.includes(c.price), `${slug}: its price, from the catalog`);
    assert.ok(text.includes('It never asks for your seed phrase or private key.'));
    assert.ok(!/\b(is|are) safe\b(?!\?)/i.test(text.replace(/never calls anything safe|that something is safe|a token is safe\?|mean a token is safe/gi, '')), `${slug}: never calls anything safe`);
    assert.ok(!/\bguarantee|earn \d|(?<!take-)profit(able)?\b/i.test(text), `${slug}: no promise of returns`);
    assert.match(body, new RegExp(`href="/agents#agent-${id}"`), 'switch it on, on the tab');
    for (const o of agentPage.list().filter(x => x.slug !== slug)) assert.ok(body.includes(`href="/agents/${o.slug}"`), `${slug} links ${o.slug}`);

    const g = graph(body);
    assert.equal(g.find(x => x['@type'] === 'FAQPage').mainEntity.length, p.faq.length);
    assert.deepEqual(g.find(x => x['@type'] === 'BreadcrumbList').itemListElement.map(i => i.name), ['Home', 'AI agents', c.name]);
    const app = g.find(x => x['@type'] === 'WebPage').about;
    assert.equal(app['@type'], 'SoftwareApplication');
    assert.equal(app.offers.price, c.plan === 'pro' ? '9' : '0');
  }
  assert.equal((await get('/agents/no-such-agent')).status, 404);
  assert.match((await get('/agents/trading-agent')).body, /No one can promise that, and RektBull doesn&#39;t\./, 'the trading agent is sold on its limits, not on returns');
});

test('the identity: crypto safety and AI agents, across the site', async () => {
  const home = (await get('/')).body;
  assert.match(home, /<title>Crypto Safety and AI Agents: Free Wallet Checkup \| RektBull<\/title>/);
  assert.match(home, /<a href="\/agents">AI agents<\/a> watch it all for you/);
  assert.match(graph(home).find(x => x['@type'] === 'Organization').description, /AI agents that watch your wallet/);
  const about = (await get('/about')).body;
  for (const { slug } of agentPage.list()) assert.ok(about.includes(`href="/agents/${slug}"`), `About links ${slug}`);
  const tab = (await get('/agents')).body;
  for (const { slug } of agentPage.list()) assert.ok(tab.includes(`href="/agents/${slug}"`), `the tab links ${slug} in its HTML`);
  const llms = (await get('/llms.txt')).body;
  assert.match(llms, /^> Crypto safety and AI agents:/m);
  assert.match(llms, /## AI agents\n- \[Wallet Checkup\]\(https:\/\/rektbull\.test\/agents\/wallet-checkup\): An AI agent that checks your wallet every week/);
  const map = (await get('/sitemap.xml')).body;
  for (const { slug } of agentPage.list()) assert.ok(map.includes(`<loc>https://rektbull.test/agents/${slug}</loc>`), slug);
});

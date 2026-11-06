/**
 * Each published weekly digest at its own address, rendered on the server:
 * a dated article with its byline, sources and Article data, sponsored posts
 * labelled, the weeks around it linked; drafts and skipped weeks never shown;
 * the digests in the sitemap with their dates and in llms.txt; and a
 * published digest pinged to IndexNow.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
const ADMIN = '0x' + 'ad'.repeat(20);
Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', ADMIN_WALLETS: ADMIN, PUBLIC_URL: 'https://rektbull.test', INDEXNOW_KEY: '0123456789abcdef0123456789abcdef', ...(DB ? { DATABASE_URL: DB } : {}) });

test('digest pages, the sitemap and llms.txt from the published weeks', { skip: !DB && 'set TEST_DATABASE_URL' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  const facts = JSON.stringify({ items: [
    { section: 'Hacks', text: '3 exploits recorded, $6.4B lost in all', source: 'DefiLlama hacks' },
    { section: 'Stablecoins', text: 'USDD ($1.5B supply): supply down 14% in a week', source: 'DefiLlama stablecoins' },
  ], not_checked: [{ check: 'reward campaigns', reason: 'Merkl didn\'t answer' }] });
  const add = (week, end, status, text, reviewed) => db.query(
    `INSERT INTO research_digests (week_start, week_end, facts, checked, text, status, reviewed_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [week, end, facts, text, status === 'published' ? text : null, status, reviewed],
  );
  await add('2026-10-12', '2026-10-19', 'published', null, '2026-10-20T09:00:00Z');
  await add('2026-10-19', '2026-10-26', 'published', '## The week in brief\nThree exploits were recorded, **$6.4B** lost in all [DefiLlama hacks]. USDD supply fell 14% in a week [DefiLlama stablecoins].\n## Hacks\n- Big Exchange lost $6.4B <script>alert(1)</script> [DefiLlama hacks]', '2026-10-27T08:30:00Z');
  await add('2026-10-26', '2026-11-02', 'skipped', 'x', '2026-11-03T08:00:00Z');
  await add('2026-11-02', '2026-11-09', 'draft', 'A draft nobody should see', null);
  await db.query(`INSERT INTO research_sponsored (week_start, placement, sponsor, headline, body, url, link_check) VALUES ('2026-10-19', 'top', 'Acme Wallet', 'A wallet that shows what you sign', 'Plain text.', 'https://acme.example/w', '{}')`);

  const server = require('../src/app').createApp().listen(0);
  t.after(async () => { server.close(); await db.getPool().end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async p => { const r = await fetch(base + p, { headers: { accept: 'text/html' } }); return { status: r.status, body: await r.text(), cache: r.headers.get('cache-control') }; };

  const page = await get('/research/2026-10-19');
  assert.equal(page.status, 200);
  assert.match(page.cache, /max-age=300/);
  const b = page.body;
  assert.match(b, /<title>Crypto Weekly Digest: Week of 19 Oct 2026 \| RektBull<\/title>/);
  assert.match(b, /<meta name="description" content="Three exploits were recorded, \$6\.4B lost in all\. USDD supply fell 14% in a week\. Big Exchange lost \$6\.4B &lt;script&gt;alert\(1\)&lt;\/script&gt;">/, 'the first sentences, without source brackets or Markdown');
  assert.match(b, /<link rel="canonical" href="https:\/\/rektbull\.test\/research\/2026-10-19">/);
  assert.match(b, /<meta property="og:type" content="article">/);
  assert.match(b, /<h1>The week of <em>19 October 2026<\/em><\/h1>/);
  assert.match(b, /Written by RektBull Research · published <time datetime="2026-10-27T08:30:00\.000Z">27 October 2026<\/time>/);
  assert.match(b, /<h2>The week in brief<\/h2>\n<p>Three exploits were recorded, <strong>\$6\.4B<\/strong> lost in all \[DefiLlama hacks\]/, 'the digest\'s sections as h2 under the page\'s h1');
  assert.ok(!b.includes('<script>alert'), 'nothing in a digest is read as markup');
  assert.match(b, /<li>USDD \(\$1\.5B supply\): supply down 14% in a week <span class="source">\[DefiLlama stablecoins\]<\/span><\/li>/);
  assert.match(b, /Not checked that week: reward campaigns \(Merkl didn&#39;t answer\)/);
  assert.match(b, /<p class="sp-label">Sponsored · Acme Wallet<\/p>/);
  assert.match(b, /href="https:\/\/rektbull\.test\/v1\/research\/sponsored\/\d+" rel="sponsored noopener"/, 'sponsored links marked and counted');
  assert.match(b, /<a href="\/research\/2026-10-12" rel="prev">← The week of 12 Oct 2026<\/a>/);
  assert.ok(!b.includes('rel="next"'), 'the skipped and draft weeks aren\'t linked');
  assert.equal((b.match(/<h1[\s>]/g) || []).length, 1);
  assert.ok(!b.includes('<!--#'));

  const graph = [...b.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(m => { const d = JSON.parse(m[1]); return d['@graph'] || [d]; });
  const article = graph.find(x => x['@type'] === 'Article');
  assert.deepEqual([article.headline, article.datePublished, article.author.name, article.publisher.name, article.isAccessibleForFree], ['RektBull Research: the week of 19 October 2026', '2026-10-27T08:30:00.000Z', 'RektBull Research', 'RektBull', true]);
  assert.deepEqual(article.citation, ['DefiLlama hacks', 'DefiLlama stablecoins']);
  assert.deepEqual(graph.find(x => x['@type'] === 'BreadcrumbList').itemListElement.map(i => i.name), ['Home', 'Research', 'The week of 19 Oct 2026']);

  const factsOnly = (await get('/research/2026-10-12')).body;
  assert.match(factsOnly, /This week was published as its facts alone, below\./);
  assert.match(factsOnly, /<meta name="description" content="Hacks, stablecoins, money flows and opportunities for the week of 12 Oct 2026, each fact with its source\. Not advice\.">/);
  assert.match(factsOnly, /rel="next">The week of 19 Oct 2026 →/);
  for (const week of ['2026-10-26', '2026-11-02', '2026-01-05']) assert.equal((await get(`/research/${week}`)).status, 404, `${week}: skipped, draft or missing`);
  assert.equal((await get('/research/nope')).status, 404);

  const sitemap = (await get('/sitemap.xml')).body;
  assert.match(sitemap, /<url><loc>https:\/\/rektbull\.test\/research\/2026-10-19<\/loc><lastmod>2026-10-27<\/lastmod><\/url>/);
  assert.match(sitemap, /<loc>https:\/\/rektbull\.test\/research\/2026-10-12<\/loc><lastmod>2026-10-20<\/lastmod>/);
  assert.ok(!/2026-10-26|2026-11-02/.test(sitemap));
  assert.match((await get('/llms.txt')).body, /## Weekly digests\n- \[The week of 2026-10-19\]\(https:\/\/rektbull\.test\/research\/2026-10-19\)\n- \[The week of 2026-10-12\]/);
  assert.match((await get('/research')).body, /The latest weekly digest covers the week of 19 October 2026/, 'and in the Research page\'s At a glance');

  // Publishing pings IndexNow (never holding up the answer).
  const axios = require('axios');
  const pinged = [];
  const post = axios.post;
  axios.post = async (url, body) => { pinged.push({ url, urls: body.urlList }); return { data: {} }; };
  try {
    const { rows: [acct] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [ADMIN]);
    const r = await fetch(`${base}/v1/admin/research/digests/2026-11-02/publish`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${require('../src/auth/siwe').issueToken(acct)}` }, body: '{}' });
    assert.equal(r.status, 200);
    await new Promise(res => setTimeout(res, 50));
    assert.deepEqual(pinged, [{ url: 'https://api.indexnow.org/indexnow', urls: ['https://rektbull.test/research/2026-11-02', 'https://rektbull.test/research'] }]);
  } finally { axios.post = post; }
  assert.equal((await get('/research/2026-11-02')).status, 200, 'published: now it has its page');
});

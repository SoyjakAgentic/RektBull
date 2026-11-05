/**
 * What search engines and link previews see: every page's title and
 * description (unique, and short enough to show whole), one canonical
 * address, preview tags and image, structured data on the home page,
 * robots.txt and the sitemap, one address per page (the .html files
 * redirect), and a real 404 for people and for the API.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: '', PUBLIC_URL: 'https://rektbull.test' });
const seo = require('../src/pages/seo');

let server, base;
test.before(() => { server = require('../src/app').createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const get = async (p, headers = {}) => { const r = await fetch(base + p, { redirect: 'manual', headers }); return { status: r.status, type: r.headers.get('content-type') || '', location: r.headers.get('location'), body: await r.text() }; };
const one = (html, re) => { const m = [...html.matchAll(re)]; assert.equal(m.length, 1, `${re} appears once`); return m[0][1]; };

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

test('structured data on the home page only, valid JSON that can\'t close its tag', async () => {
  const home = (await get('/')).body;
  const ld = JSON.parse(one(home, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g));
  assert.deepEqual(ld.map(x => x['@type']), ['Organization', 'WebSite']);
  assert.equal(ld[0].logo, 'https://rektbull.test/icon-512.png');
  assert.ok(!(await get('/safety')).body.includes('application/ld+json'));
});

test('robots.txt, the sitemap, the icons and the preview image', async () => {
  const robots = await get('/robots.txt');
  assert.match(robots.type, /text\/plain/);
  assert.equal(robots.body, 'User-agent: *\nAllow: /\n\nSitemap: https://rektbull.test/sitemap.xml\n', 'nothing blocked: the pages fetch /v1 as they render');
  const map = await get('/sitemap.xml');
  assert.match(map.type, /application\/xml/);
  const locs = [...map.body.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
  assert.deepEqual(locs, Object.keys(seo.PAGES).map(r => `https://rektbull.test${r}`));
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
  const page = await get('/no-such-page', { accept: 'text/html' });
  assert.equal(page.status, 404);
  assert.match(page.body, /<meta name="robots" content="noindex">/);
  assert.match(page.body, /Nothing here/);
  const api = await get('/v1/no-such-thing', { accept: 'text/html' });
  assert.deepEqual([api.status, JSON.parse(api.body)], [404, { error: 'not_found' }], 'the API answers JSON');
  assert.deepEqual(JSON.parse((await get('/no-such-page')).body), { error: 'not_found' }, 'a client that doesn\'t ask for HTML gets JSON');
});

/**
 * Phones first: every page carries the tab bar (shown on phones by
 * site.css) and the web app manifest, so the site can be installed on a home
 * screen. The page itself is checked in Chromium by test/browser/mobile.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: '', PUBLIC_URL: 'https://rektbull.test' });

test('the manifest: installable, with its icons on disk', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url.startsWith('/'), true);
  assert.ok(m.icons.some(i => i.sizes === '192x192') && m.icons.some(i => i.sizes === '512x512') && m.icons.some(i => i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', i.src)), i.src);
});

test('every page: the tab bar and the manifest link', async t => {
  const server = require('../src/app').createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const p of ['/', '/trade', '/perps', '/launches', '/agents']) {
    const html = await (await fetch(base + p)).text();
    assert.match(html, /<nav class="tabbar" aria-label="Quick">/, p);
    for (const tab of ['/trade', '/launches', '/perps', '/agents']) assert.match(html, new RegExp(`<a href="${tab}" data-tab="${tab}">`), `${p}: ${tab}`);
    assert.match(html, /id="tab-account"/, p);
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/, p);
  }
  const r = await fetch(base + '/manifest.webmanifest');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /manifest\+json/);
});

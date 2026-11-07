/**
 * The bull: every committed brand file matches the code that draws it
 * (brand/bull.js), so nobody edits one by hand and lets the set drift; the
 * icons are the sizes their stores ask for; the site uses the new mark; and
 * the old hidden mark (which read as a yen sign) is gone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bull, mark, MOODS } = require('../brand/bull');
const { MEMES } = require('../brand/render');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const pngSize = file => { const b = fs.readFileSync(path.join(ROOT, file)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('every face and the mark, as committed, are what brand/bull.js draws', () => {
  assert.deepEqual(MOODS, ['calm', 'rekt', 'sweating', 'shook', 'steaming', 'shades']);
  for (const m of MOODS) {
    assert.equal(read('public', 'brand', `bull-${m}.svg`), bull(m), `bull-${m}.svg: run node brand/render.js`);
    assert.equal(read('public', 'brand', `bull-${m}-sticker.svg`), bull(m, { sticker: true }), `bull-${m}-sticker.svg`);
    assert.deepEqual(pngSize(`public/brand/stickers/bull-${m}.png`), [512, 512]);
  }
  assert.equal(read('public', 'brand', 'mark.svg'), mark());
  assert.equal(read('public', 'favicon.svg'), mark(), 'the favicon is the mark');
  assert.equal(read('snap', 'images', 'icon.svg'), mark({ size: 64 }), 'the Snap\'s icon is the mark');
  for (const [file] of MEMES) assert.deepEqual(pngSize(`brand/memes/${file}.png`), [1080, 1080], file);
});

test('the icons are the sizes their places ask for', () => {
  assert.deepEqual(pngSize('public/favicon-48.png'), [48, 48]);
  assert.deepEqual(pngSize('public/apple-touch-icon.png'), [180, 180]);
  assert.deepEqual(pngSize('public/icon-512.png'), [512, 512]);
  assert.deepEqual(pngSize('public/og.png'), [1200, 630]);
  const manifest = JSON.parse(read('extension', 'manifest.json'));
  for (const [size, file] of Object.entries(manifest.icons || {})) assert.deepEqual(pngSize(`extension/${file}`), [Number(size), Number(size)], `extension icon ${size}`);
});

test('the site uses the new mark, and the old hidden one is gone', () => {
  for (const f of ['header.html', 'footer.html']) {
    const html = read('src', 'pages', f);
    assert.match(html, /<a class="logo" href="\/"[^>]*>\s*<svg [^>]*aria-hidden="true">/, `${f}: the mark, marked decorative`);
    assert.ok(html.includes('#f5b700'), `${f}: the gold nose ring`);
    assert.ok(!html.includes('--accent-ink'), `${f}: the old mark (it read as a yen sign) is gone`);
  }
  const ids = ['header.html', 'footer.html'].map(f => read('src', 'pages', f).match(/clipPath id="([^"]+)"/)[1]);
  assert.notEqual(ids[0], ids[1], 'header and footer marks don\'t share an id on the same page');
  assert.match(read('public', '404.html'), /src="\/brand\/bull-shook\.svg"/);
});

test('the memes never claim safety or returns', () => {
  for (const [, mood, top, bottom] of MEMES) {
    assert.ok(MOODS.includes(mood));
    assert.ok(!/\bsafe\b|guarantee|earn \d|apy|returns?\b/i.test(`${top} ${bottom}`), `"${top} / ${bottom}"`);
  }
});

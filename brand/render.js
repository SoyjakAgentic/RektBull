/**
 * Renders RektBull's brand files from brand/bull.js. Run after changing the
 * bull; the results are committed. Needs Playwright (Chromium):
 *
 *   node brand/render.js
 *
 * Writes:
 *   public/brand/bull-<mood>.svg, bull-<mood>-sticker.svg, mark.svg   (the site serves these)
 *   public/brand/stickers/bull-<mood>.png   512 px, transparent, white border: to post anywhere
 *   public/favicon.svg, favicon-48.png, apple-touch-icon.png, icon-512.png, og.png
 *   brand/memes/*.png   1080 px captioned memes for launch posts (not served)
 *   extension/icons/icon{16,32,48,128}.png, snap/images/icon.svg
 *     (after changing the Snap's icon: `cd snap && npm run build` to update its shasum)
 */
const fs = require('fs');
const path = require('path');
const { bull, mark, MOODS } = require('./bull');

const ROOT = path.join(__dirname, '..');
const out = (...p) => path.join(ROOT, ...p);
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };

/** Captioned memes: [file, mood, top line, bottom line]. Self-deprecating or about the attack, never about the people hit. */
const MEMES = [
  ['dont-get-rekt', 'calm', 'Don\'t get rekt.', 'Check your wallet first: rektbull.com'],
  ['unlimited-approval', 'sweating', 'Me after approving unlimited USDC', 'to a contract I can\'t name'],
  ['cant-sell', 'shook', 'When the token you bought', 'can\'t be sold'],
  ['didnt-check', 'rekt', 'Didn\'t check the approvals.', 'Got rekt.'],
  ['checked-first', 'shades', 'Revoked my old approvals', 'before the hack news hit'],
  ['bull-market', 'steaming', 'Bull market energy', 'Still checking every signature'],
];

(async () => {
  // SVGs
  for (const m of MOODS) {
    write(out('public', 'brand', `bull-${m}.svg`), bull(m));
    write(out('public', 'brand', `bull-${m}-sticker.svg`), bull(m, { sticker: true }));
  }
  write(out('public', 'brand', 'mark.svg'), mark());
  write(out('public', 'favicon.svg'), mark());
  write(out('snap', 'images', 'icon.svg'), mark({ size: 64 }));

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const shot = async (html, w, h, file, transparent = false) => {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;${transparent ? '' : 'background:#fff;'}overflow:hidden">${html}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, omitBackground: transparent });
    await page.close();
  };
  const centered = (svg, w, h, bg) => `<div style="width:${w}px;height:${h}px;display:grid;place-items:center;background:${bg}">${svg}</div>`;

  // Icons
  await shot(centered(mark({ size: 48 }), 48, 48, 'transparent'), 48, 48, out('public', 'favicon-48.png'), true);
  await shot(centered(bull('calm', { size: 150 }), 180, 180, '#edf1f8'), 180, 180, out('public', 'apple-touch-icon.png'));
  await shot(centered(bull('calm', { size: 440 }), 512, 512, '#ffffff'), 512, 512, out('public', 'icon-512.png'));
  for (const s of [16, 32, 48]) await shot(centered(mark({ size: s }), s, s, 'transparent'), s, s, out('extension', 'icons', `icon${s}.png`), true);
  // Chrome asks for 16 px of transparent space around a 96 px image in the 128 px icon.
  await shot(centered(bull('calm', { size: 96 }), 128, 128, 'transparent'), 128, 128, out('extension', 'icons', 'icon128.png'), true);

  // Stickers: transparent, white border, to post anywhere.
  for (const m of MOODS) await shot(centered(bull(m, { size: 512, sticker: true }), 512, 512, 'transparent'), 512, 512, out('public', 'brand', 'stickers', `bull-${m}.png`), true);

  // The link preview: the bull, the line, the address.
  // The site's own fonts, embedded (a blank page may not load local files).
  const font = (pkg, file) => `data:font/woff2;base64,${fs.readFileSync(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'files', file)).toString('base64')}`;
  const fontFace = `
    @font-face { font-family: B; font-weight: 200 800; src: url(${font('@fontsource-variable/bricolage-grotesque', 'bricolage-grotesque-latin-wght-normal.woff2')}) format("woff2"); }
    @font-face { font-family: P; font-weight: 500; src: url(${font('@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-500-normal.woff2')}) format("woff2"); }`;
  await shot(`<style>${fontFace}
      .og { width: 1200px; height: 630px; box-sizing: border-box; padding: 72px 80px; color: #e9eef8; font-family: P, sans-serif; display: flex; flex-direction: column;
            background: radial-gradient(900px 500px at 85% 0%, #1e2f6b 0%, #0d1424 60%); position: relative; }
      .logo { display: flex; align-items: center; gap: 14px; font: 800 38px B; letter-spacing: -.02em; }
      h1 { font: 800 112px/1 B; letter-spacing: -.045em; margin: auto 0 22px; max-width: 760px; }
      h1 em { font-style: normal; color: #8aa4ff; }
      p { font-size: 32px; line-height: 1.35; color: #b9c4d9; margin: 0 0 36px; max-width: 700px; }
      .foot { font-size: 26px; color: #95a2bb; } .foot b { color: #e9eef8; font-weight: 500; }
      .bull { position: absolute; right: 56px; top: 150px; }
    </style>
    <div class="og">
      <div class="logo">${mark({ size: 52 })}RektBull</div>
      <div class="bull">${bull('calm', { size: 330, sticker: true })}</div>
      <h1>Don't get <em>rekt.</em></h1>
      <p>Check what you sign, hold, claim and pay for. Every fact with its source.</p>
      <div class="foot"><b>rektbull.com</b> · Free wallet checkup · 6 chains</div>
    </div>`, 1200, 630, out('public', 'og.png'));

  // Memes: big bull, classic top and bottom lines.
  for (const [file, mood, top, bottom] of MEMES) {
    await shot(`<style>${fontFace}
        .m { width: 1080px; height: 1080px; box-sizing: border-box; background: #2346d6; display: grid; grid-template-rows: auto 1fr auto; justify-items: center; padding: 56px 48px 40px; font-family: B, sans-serif; }
        .t { font: 800 76px/1.05 B; letter-spacing: -.03em; color: #fff; text-align: center; text-wrap: balance; -webkit-text-stroke: 3px #0d1424; paint-order: stroke fill; }
        .f { display: flex; width: 100%; justify-content: space-between; align-items: center; color: #dfe6f5; font: 500 26px P, sans-serif; margin-top: 14px; }
      </style>
      <div class="m"><div class="t">${top}</div><div style="display:grid;place-items:center">${bull(mood, { size: 600, sticker: true })}</div>
        <div style="width:100%"><div class="t">${bottom}</div><div class="f"><span style="display:flex;gap:10px;align-items:center">${mark({ size: 36 })}RektBull</span><span>rektbull.com</span></div></div></div>`,
    1080, 1080, out('brand', 'memes', `${file}.png`));
  }
  await browser.close();
  console.log(`wrote ${MOODS.length * 2 + 1} SVGs, ${MOODS.length} stickers, ${MEMES.length} memes, the site and store icons and og.png`);
})().catch(err => { console.error(err); process.exit(1); });

module.exports = { MEMES };

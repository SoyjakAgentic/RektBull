/**
 * Drives the Launches desk's Live card in a real browser (Playwright's
 * Chromium) with the live feed as a stand-in: the three columns, a launch
 * arriving 10 seconds later and marked new, the network switch, and phone width.
 *
 *   node test/browser/launchesLive.js
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test';
require('../../src/config/env').databaseUrl = '';
const addr = n => '0x' + n.toString(16).padStart(40, '0');
const ago = s => new Date(Date.now() - s * 1000).toISOString();

const launches = require('../../src/services/launches');
launches.feed = async ({ chain }) => ({ chain, chain_name: chain, tokens: [], sources: ['stand-in'], note: '' });
launches.curves = async ({ chain }) => ({ chain, launchpad: 'x', tokens: [], source: 'stand-in', note: '' });

let reads = 0;
const items = [
  { chain: 'base', launchpad: 'clanker', launchpad_name: 'Clanker', token: addr(0x501), symbol: 'CLK', name: 'Clank', creator: addr(0xa2), at: ago(40), flags: { flags: [{ level: 'warn', text: 'More can be minted', source: 'GoPlus' }] } },
  { chain: 'base', launchpad: 'zora', launchpad_name: 'Zora', token: addr(0x502), symbol: 'ZED', name: 'Zed', creator: addr(0xb1), at: ago(90), flags: { flags: [{ level: 'ok', text: 'None of GoPlus\'s red flags', source: 'GoPlus' }] } },
];
require('../../src/services/liveLaunches').live = async ({ chain }) => {
  reads++;
  const fresh = reads > 1 && chain === 'base' ? [{ chain, launchpad: 'virtuals', launchpad_name: 'Virtuals', token: addr(0x503), symbol: 'NEWB', name: 'Brand new', creator: null, at: ago(3) }] : [];
  return {
    chain, chain_name: chain === 'bsc' ? 'BNB Chain' : 'Base', read_at: new Date().toISOString(), refresh_seconds: 10,
    columns: {
      new: { items: chain === 'bsc' ? [{ chain, launchpad: 'fourmeme', launchpad_name: 'four.meme', token: addr(0x601), symbol: 'FOUR', name: 'Four', creator: addr(0xc0), at: ago(5) }] : [...fresh, ...items], source: 'stand-in launch events' },
      graduating: { items: [{ token: addr(0x507), symbol: 'CURVE', launchpad: 'virtuals', launchpad_name: 'Virtuals', progress_pct: 91.5, tradable: true }, { token: addr(0x508), symbol: 'OTHERQ', launchpad: 'fourmeme', launchpad_name: 'four.meme', progress_pct: 80, tradable: false }], source: 'stand-in purchases' },
      graduated: { items: [{ token: addr(0x505), symbol: 'GRAD', launchpad: 'virtuals', launchpad_name: 'Virtuals', agent_token: addr(0x506), at: ago(3600) }], hours_covered: 24, source: 'stand-in graduations' },
    },
    note: 'Not financial advice.',
  };
};

(async () => {
  const { createApp } = require('../../src/app');
  const server = createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.clock.install();
  try {
    await page.goto(`${url}/launches`);
    await page.locator('#v-new li.live-item').first().waitFor();
    assert.deepEqual(await page.$$eval('#v-new .live-top strong', s => s.map(x => x.textContent)), ['CLK', 'ZED']);
    assert.equal(await page.locator('#v-new li.fresh').count(), 0, 'nothing is marked new on the first read');
    assert.match(await page.textContent('#v-new li:first-child'), /Launched \d+ s ago by 0x0000…00a2.*More can be minted/s);
    assert.equal(await page.getAttribute('#v-new li:first-child a.primary', 'href'), `/trade?chain=base&token=${addr(0x501)}&side=buy#trade-card`);
    assert.equal(await page.getAttribute('#v-new li:first-child a:not(.primary)', 'href'), `/token?chain=base&token=${addr(0x501)}`);
    console.log('✔ new launches: newest first, with who launched them, their flags, a checked buy and the token page');

    assert.equal(await page.getAttribute('#v-near li:first-child [role=progressbar]', 'aria-valuenow'), '91.5');
    assert.match(await page.textContent('#v-near li:nth-child(2)'), /Priced in another token/);
    assert.equal(await page.locator('#v-near li:nth-child(2) a.primary').count(), 0, 'no buy button for a curve RektBull doesn\'t trade');
    assert.match(await page.textContent('#v-grad li'), /Graduated 1 h ago; it now trades as 0x0000/);
    assert.equal(await page.getAttribute('#v-grad li a.primary', 'href'), `/trade?chain=base&token=${addr(0x506)}&side=buy#trade-card`, 'a graduated Virtuals token is bought as its new token');
    console.log('✔ nearest to graduating with its progress; just graduated with the token it became');

    await page.clock.runFor(10500);
    await page.locator('#v-new li.fresh').waitFor();
    assert.deepEqual(await page.$$eval('#v-new .live-top strong', s => s.map(x => x.textContent)), ['NEWB', 'CLK', 'ZED']);
    assert.equal(await page.locator('#v-new li.fresh').count(), 1, 'only the one that just arrived is marked');
    assert.match(await page.textContent('#v-status'), /Updated .* · 1 new/);
    console.log('✔ 10 seconds later, a new launch appears by itself, marked new');

    await page.selectOption('#v-chain', 'bsc');
    await page.locator('#v-new .live-top strong', { hasText: 'FOUR' }).waitFor();
    assert.equal(await page.locator('#v-new li.fresh').count(), 0, 'switching network isn\'t "new"');
    console.log('✔ BNB Chain: four.meme\'s launches');

    if (process.env.SCREENSHOT_DESKTOP) { await page.selectOption('#v-chain', 'base'); await page.locator('#v-new .live-top strong', { hasText: 'CLK' }).waitFor(); await page.locator('#live-card').screenshot({ path: process.env.SCREENSHOT_DESKTOP }); }
    await page.setViewportSize({ width: 375, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'no sideways scroll at phone width');
    await page.screenshot({ path: process.env.SCREENSHOT || '/tmp/rektbull-launches-live.png', fullPage: false });
    console.log('✔ phone width: the columns stack, no sideways scroll');

    assert.deepEqual(errors.filter(e => !/Failed to load resource/.test(e)), [], 'no page errors');
    console.log('all passed');
  } catch (err) {
    console.error('FAILED:', err.message, errors);
    await page.screenshot({ path: '/tmp/rektbull-launches-failed.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();

/**
 * Drives /token in a real browser (Playwright's Chromium) against a test
 * server whose providers are stand-ins: the facts, the candle chart, live
 * trades, holders, links checked for phishing, the buy buttons, and phone width.
 *
 *   node test/browser/tokenPage.js
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test';
require('../../src/config/env').databaseUrl = '';
const TOKEN = '0x' + 'ab'.repeat(20);
const POOL = '0x' + 'cd'.repeat(20);
const CREATOR = '0x' + 'c0'.repeat(20);

require('../../src/providers/dexscreener').market = async () => ({
  source: 'DexScreener', pairs: 2, price_usd: 0.000742, change_24h_pct: -3.2, liquidity_usd_total: 120000, volume_24h_usd: 50000, market_cap_usd: 900000,
  first_pair_created_at: new Date(Date.now() - 30 * 3600000).toISOString(), main_pair: { dex: 'uniswap', address: POOL, quote: 'WETH' },
  token_name: 'Test Coin', token_symbol: 'TEST',
  links: [{ label: 'Website', url: 'https://test.example/' }, { label: 'Claim', url: 'https://claim-test.example/airdrop' }],
});
require('../../src/services/discover').goplusReport = async () => ({
  holder_count: 4200, top10_people_pct: 22.5, creator_address: CREATOR, mintable: true,
  top_holders: [{ address: POOL, is_contract: true, share: 0.41 }, { address: '0x' + '1c'.repeat(20), is_contract: true, is_locked: true, tag: 'UNCX', share: 0.2 }, { address: CREATOR, share: 0.05 }],
});
require('../../src/services/launchpads').identify = async () => ({ launchpad: 'virtuals', name: 'Virtuals', state: 'curve', link: 'https://app.virtuals.io/prototypes/x', source: 'Virtuals\' Bonding contract',
  curve: { progress_pct: 62.5, in_curve: 4100, in_curve_symbol: 'VIRTUAL', graduates_at: 125000000, buy_tax_pct: 1, sell_tax_pct: 1 } });
require('../../src/providers/goplus').phishingSite = async origin => ({ phishing: origin === 'https://claim-test.example' });
require('../../src/services/approvals').multicall = async (_c, calls) => calls.map(c => ({ ok: true, value: [c.fn === 'balanceOf' ? 30n : 1000n] }));
const gt = require('../../src/providers/geckoterminal');
const now = Math.floor(Date.now() / 1000);
gt.candles = async () => Array.from({ length: 48 }, (_, i) => { const o = 0.0007 + Math.sin(i / 5) * 0.00005; const c = o + (i % 3 - 1) * 0.00001; return [now - (48 - i) * 3600, o, Math.max(o, c) + 0.000005, Math.min(o, c) - 0.000005, c, 1000 + i]; });
gt.trades = async () => [
  { at: new Date(Date.now() - 20000).toISOString(), side: 'buy', tokens: 25000, usd: 19.48, price_usd: 0.00078, wallet: '0x' + 'a'.repeat(40), tx: '0x' + '1'.repeat(64) },
  { at: new Date(Date.now() - 90000).toISOString(), side: 'sell', tokens: 1000, usd: 0.77, price_usd: 0.00077, wallet: '0x' + 'b'.repeat(40), tx: '0x' + '2'.repeat(64) },
];

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
  try {
    await page.goto(`${url}/token?chain=base&token=${TOKEN}`);
    await page.getByRole('heading', { name: 'TEST on Base' }).waitFor();
    assert.match(await page.textContent('#tp-tiles'), /\$0\.0007420.*-3\.2% in 24 h.*\$120\.0K.*\$900\.0K/s);
    console.log('✔ the facts: price (to a fraction of a cent), change, liquidity, market cap');

    await page.locator('#tp-plot rect').first().waitFor();
    assert.equal(await page.locator('#tp-plot rect').count(), 48, 'a candle per hour');
    assert.ok(await page.locator('#tp-plot rect.up').count() > 0 && await page.locator('#tp-plot rect.down').count() > 0);
    await page.hover('#tp-plot', { position: { x: 300, y: 100 } });
    assert.match(await page.textContent('#tp-plot .tip'), /open \$0\.000\d+ · high .* traded/);
    assert.match(await page.textContent('#tp-chart-src'), /GeckoTerminal/);
    console.log('✔ the chart: candles drawn on the page from GeckoTerminal\'s figures, with a readout on hover');

    await page.locator('#tp-trades tbody tr').first().waitFor();
    assert.equal(await page.locator('#tp-trades tbody tr').count(), 2);
    assert.match(await page.textContent('#tp-trades tbody tr:first-child'), /s ago.*Buy.*25\.0K.*\$19\.48/s);
    assert.equal(await page.getAttribute('#tp-trades tbody tr:first-child a', 'href'), 'https://basescan.org/tx/0x' + '1'.repeat(64));
    console.log('✔ live trades: newest first, each linked to the explorer');

    assert.match(await page.textContent('#tp-creator'), /The creator 0xc0c0…c0c0 holds 3% of the supply now/);
    assert.deepEqual(await page.$$eval('#tp-holders tbody tr', r => r.map(x => x.children[1].textContent)), ['Its main pool', 'Locked · UNCX', 'The creator']);
    console.log('✔ holders: the pool, a locker and the creator marked; what the creator holds now');

    assert.match(await page.textContent('#tp-pad'), /To graduating.*62\.5%/s);
    assert.equal(await page.getAttribute('#tp-pad [role=progressbar]', 'aria-valuenow'), '62.5');
    console.log('✔ launchpad: how close the curve is to graduating');

    assert.equal(await page.locator('#tp-links a[href="https://test.example/"]').count(), 1);
    assert.equal(await page.locator('#tp-links a[href*="claim-test"]').count(), 0, 'a phishing site is never linked');
    assert.match(await page.textContent('#tp-links'), /claim-test\.example — on GoPlus's phishing list, so not linked/);
    assert.match(await page.textContent('#tp-flags'), /More can be minted/);
    console.log('✔ warning signs: GoPlus\'s flags; a link on the phishing list is shown but not linked');

    assert.deepEqual(await page.$$eval('#tp-buys a', a => a.map(x => [x.textContent, new URL(x.href).search])), [
      ['Buy $25', `?chain=base&token=${TOKEN}&side=buy&amount=25`], ['Buy $50', `?chain=base&token=${TOKEN}&side=buy&amount=50`], ['Buy $100', `?chain=base&token=${TOKEN}&side=buy&amount=100`]]);
    console.log('✔ buy buttons go to the Trade desk with the amount set, where the checks run at once');

    await page.screenshot({ path: process.env.SCREENSHOT || '/tmp/rektbull-token.png', fullPage: true });
    await page.setViewportSize({ width: 375, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'no sideways scroll at phone width');
    await page.screenshot({ path: process.env.SCREENSHOT_PHONE || '/tmp/rektbull-token-phone.png', fullPage: true });
    console.log('✔ phone width: no sideways scroll');

    await page.goto(`${url}/token`);
    await page.locator('#find-card').waitFor();
    await page.fill('#tp-token', TOKEN);
    await page.click('#tp-form button');
    await page.waitForURL(`${url}/token?chain=base&token=${TOKEN}`);
    console.log('✔ no token given: a form to open one');

    assert.deepEqual(errors.filter(e => !/Failed to load resource/.test(e)), [], 'no page errors');
    console.log('all passed');
  } catch (err) {
    console.error('FAILED:', err.message, errors);
    await page.screenshot({ path: '/tmp/rektbull-token-failed.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();

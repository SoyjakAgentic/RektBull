/**
 * Phones first, in a real Chromium as an iPhone: the tab bar under the thumb
 * marks the page you're on, Account opens the wallet menu, the top menu scrolls
 * in one line, and no page scrolls sideways. Needs no database.
 *
 *   node test/browser/mobile.js [screenshot.png]
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');

Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: '' });

(async () => {
  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const { chromium, devices } = require('playwright');
  const browser = await chromium.launch();
  try {
    const phone = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
    for (const [p, tab] of [['/', null], ['/trade', 'Trade'], ['/perps', 'Perps'], ['/launches', 'Launches'], ['/agents', 'Alerts'], ['/safety', null], ['/markets', null]]) {
      await phone.goto(url + p);
      const s = await phone.evaluate(() => ({
        sideways: document.documentElement.scrollWidth > window.innerWidth,
        tabbar: getComputedStyle(document.querySelector('.tabbar')).display,
        current: document.querySelector('.tabbar [aria-current]')?.textContent || null,
        navWraps: document.querySelector('.nav').scrollHeight > 60,
        bottomGap: parseFloat(getComputedStyle(document.body).paddingBottom),
      }));
      assert.equal(s.sideways, false, `${p}: no sideways scroll`);
      assert.equal(s.tabbar, 'grid', `${p}: the tab bar shows`);
      assert.equal(s.current, tab, `${p}: the tab marked`);
      assert.equal(s.navWraps, false, `${p}: the top menu stays one line`);
      assert.ok(s.bottomGap >= 72, `${p}: the page ends above the tab bar`);
    }
    console.log('✔ the tab bar on every page, the current one marked, no sideways scroll');

    // Account: what the header's button does. In a phone browser with no wallet in it, that's the way to one.
    await phone.goto(url + '/trade');
    await phone.tap('#tab-account');
    await phone.locator('#toast', { hasText: 'No wallet found' }).waitFor();
    if (process.argv[2]) await phone.screenshot({ path: process.argv[2] });
    console.log('✔ Account does what the header\'s button does');

    // Touch targets: buttons are at least 44 px tall.
    const small = await phone.evaluate(() => [...document.querySelectorAll('button:not(.link), .btn')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 43.5).map(b => b.textContent.trim().slice(0, 30)));
    assert.deepEqual(small, [], 'buttons a thumb can hit');
    console.log('✔ touch targets');

    // A desktop: no tab bar, the menu as before.
    const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await desk.goto(url + '/trade');
    assert.equal(await desk.evaluate(() => getComputedStyle(document.querySelector('.tabbar')).display), 'none');
    console.log('ok: phones first');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(err => { console.error(err); process.exit(1); });

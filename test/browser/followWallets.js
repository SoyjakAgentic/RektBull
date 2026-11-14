/**
 * Drives the Launches desk's "Wallets you follow" card in a real browser
 * (Playwright's Chromium), with the wallet tracker as a stand-in: signed out,
 * following a wallet, its trades with a checked buy, a new trade marked as it
 * arrives 10 seconds later, the free limit, stopping, and phone width.
 *
 *   node test/browser/followWallets.js
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test';
require('../../src/config/env').databaseUrl = '';
const addr = n => '0x' + n.toString(16).padStart(40, '0');
const ago = s => new Date(Date.now() - s * 1000).toISOString();
const W = addr(0xaa01), MEME = addr(0xee05), USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const launches = require('../../src/services/launches');
launches.feed = async ({ chain }) => ({ chain, chain_name: chain, tokens: [], sources: ['stand-in'], note: '' });
launches.curves = async ({ chain }) => ({ chain, launchpad: 'x', tokens: [], source: 'stand-in', note: '' });
require('../../src/services/liveLaunches').live = async ({ chain }) => ({ chain, chain_name: 'Base', read_at: new Date().toISOString(), refresh_seconds: 10, columns: { new: { items: [], source: 's' }, graduating: { items: [], source: 's' }, graduated: { items: [], hours_covered: 24, source: 's' } }, note: '' });

const wt = require('../../src/services/walletTracker');
const followed = [];
const trades = [];
let sellComing = false;
const trade = (tx, side, token, symbol, amount, other, usd, at) => ({ chain: 'base', chain_name: 'Base', wallet: W, label: 'Smart money', side, token, symbol, amount, other, usd, tx, tx_url: `https://basescan.org/tx/${tx}`, at, buy: `/trade?chain=base&token=${token}&side=buy#trade-card`, page: `/token?chain=base&token=${token}` });
wt.list = async () => {
  if (sellComing && trades.length === 1) trades.unshift(trade('0x' + '2'.repeat(64), 'sell', MEME, 'MEME', 500000, { native: true, symbol: 'ETH', amount: null }, 210.5, ago(2)));
  return { wallets: followed.map((w, i) => ({ id: i + 1, address: w.address, family: 'evm', label: w.label || null, created_at: ago(600) })), limit: 5, free_limit: 5, pro_limit: 25, safety_pro: false, alerts_on: true, chains: ['Base'], trades: followed.length ? trades : [], source: 'stand-in transfers', note: 'Not advice.' };
};
wt.follow = async (_id, { address, label }) => {
  const w = wt.parseAddress(address);
  if (followed.length >= 5) throw new wt.TrackerRefused('You can follow up to 5 wallets for free, and 25 with Safety Pro. Stop following one first, or get Safety Pro.', 402, { offer: 'pro_30d' });
  followed.push({ address: w.address, label });
  if (!trades.length) trades.push(trade('0x' + '1'.repeat(64), 'buy', MEME, 'MEME', 1234567, { token: USDC, symbol: 'USDC', amount: 1500 }, 1500, ago(120)));
  return wt.list();
};
wt.unfollow = async (_id, id) => { followed.splice(Number(id) - 1, 1); return wt.list(); };

(async () => {
  const { createApp } = require('../../src/app');
  const server = createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/status of (400|401|402)/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  await page.clock.install();
  try {
    await page.goto(`${url}/launches#follow-card`);
    assert.equal(await page.isVisible('#f-on'), false);
    assert.match(await page.textContent('#f-off'), /Sign in to follow wallets/);
    console.log('✔ signed out: asks to sign in');

    const token = require('../../src/auth/siwe').issueToken({ id: 7, wallet: addr(0xabc) });
    await page.evaluate(([t, a]) => { sessionStorage.setItem('rb_token', t); sessionStorage.setItem('rb_wallet', a); }, [token, addr(0xabc)]);
    await page.reload();
    await page.locator('#f-on').waitFor();
    assert.match(await page.textContent('#f-trades'), /Follow a wallet to see its trades here/);

    await page.fill('#f-address', 'not a wallet');
    await page.click('#f-form button[type=submit]');
    await page.waitForFunction(() => /isn't a wallet address/.test(document.getElementById('f-msg').textContent));
    await page.fill('#f-address', W.toUpperCase().replace('0X', '0x'));
    await page.fill('#f-label', 'Smart money');
    await page.click('#f-form button[type=submit]');
    await page.waitForFunction(() => /Following\./.test(document.getElementById('f-msg').textContent));
    assert.match(await page.textContent('#f-wallets'), /Smart money \(0x0000…aa01\)/);
    assert.equal(await page.textContent('#f-status'), '1 of 5 wallets');
    assert.match(await page.textContent('#f-trades li:first-child'), /Smart money bought 1\.23M MEME for 1,500 USDC \(about \$1,500\).*Base · 2 min ago/s);
    assert.equal(await page.getAttribute('#f-trades li:first-child a.primary', 'href'), `/trade?chain=base&token=${MEME}&side=buy#trade-card`);
    assert.equal(await page.getAttribute('#f-trades li:first-child a.btn:not(.primary)', 'href'), `/token?chain=base&token=${MEME}`);
    assert.equal(await page.locator('#f-trades li.fresh').count(), 0, 'nothing marked new on the first read');
    console.log('✔ following a wallet: named, its trade with what was paid, a checked buy and the token page');

    await page.locator('#follow-card').scrollIntoViewIfNeeded();
    sellComing = true;
    await page.clock.runFor(10500);
    await page.waitForFunction(() => document.querySelectorAll('#f-trades li.live-item').length === 2);
    assert.match(await page.textContent('#f-trades li:first-child'), /Smart money sold 500,000 MEME for ETH \(about \$210\.50\)/);
    assert.equal(await page.locator('#f-trades li:first-child.fresh').count(), 1, 'the new trade is marked');
    assert.equal(await page.locator('#f-trades li:first-child a.primary').count(), 0, 'a sale offers the token page, not a buy');
    console.log('✔ 10 seconds later, a new trade appears by itself, marked new');

    for (let i = 1; i < 5; i++) {
      await page.fill('#f-address', addr(0x5000 + i));
      await page.click('#f-form button[type=submit]');
      await page.waitForFunction(n => document.getElementById('f-status').textContent === `${n} of 5 wallets`, i + 1);
    }
    await page.fill('#f-address', addr(0x6000));
    await page.click('#f-form button[type=submit]');
    await page.waitForFunction(() => /up to 5 wallets for free/.test(document.getElementById('f-msg').textContent));
    assert.equal(await page.getAttribute('#f-msg a', 'href'), '/safety#pro-card');
    console.log('✔ the free limit says so, with Safety Pro offered');

    await page.click('#f-wallets .watched:first-child button');
    await page.waitForFunction(() => document.getElementById('f-status').textContent === '4 of 5 wallets');
    console.log('✔ stop following');

    await page.setViewportSize({ width: 375, height: 800 });
    await page.locator('#follow-card').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
    console.log('✔ phone width: no sideways scroll');

    assert.deepEqual(errors, []);
    console.log('all passed');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(err => { console.error(err); process.exit(1); });

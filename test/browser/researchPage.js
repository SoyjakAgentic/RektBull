/**
 * Drives /research in a real browser against the real server, with
 * DefiLlama, the other desks and Claude as stand-ins. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/researchPage.js
 */
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', ANTHROPIC_API_KEY: 'test' });

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  const today = new Date();
  const ago = d => new Date(today - d * 86400000).toISOString().slice(0, 10);
  const H = (d, name, amount, technique, extra) => ({ date: ago(d), name, amount_usd: amount, returned_usd: null, technique, classification: 'Protocol Logic', chains: ['Ethereum', 'Base'], bridge: false, target: 'DeFi Protocol', source: null, ...extra });
  require('../../src/providers/llama').hackList = async () => [
    H(2, 'Recent Lend', 4e5, 'Withdrawal Logic Flaw', { source: 'https://example.com/postmortem' }),
    H(6, 'Big Exchange', 6.4e9, 'Key Leaked via Infrastructure', { target: 'CEX' }),
    H(9, 'Small Vault', 1e6, 'Withdrawal Logic Flaw', { returned_usd: 5e5 }),
    H(60, 'Older Pool', null, 'Oracle Manipulation'),
  ];
  const markets = require('../../src/services/markets');
  markets.overview = async () => ({ tvl: { usd: 85e9, change_7d_pct: -0.9 }, not_checked: [], sources: { tvl: 'DefiLlama TVL' } });
  markets.stablecoinList = async () => ({ source: 'DefiLlama stablecoins', stablecoins: [] });
  require('../../src/services/discover').dapps = async () => ({ dapps: [] });
  require('../../src/services/opportunities').campaigns = async () => ({ total: 0, campaigns: [] });
  const claude = require('../../src/ai/claude');
  claude.available = () => true;
  claude.write = async () => ({ text: '## The week in brief\nThree exploits were recorded, **$6.4B** lost in all [DefiLlama hacks].\n## Hacks\n- Big Exchange lost $6.4B [DefiLlama hacks]', model: 'test-model' });
  const research = require('../../src/services/research');
  const w = research.lastWeek(today);
  await research.makeDigest(w);
  claude.available = () => false;
  await research.makeDigest({ start: new Date(w.start - 7 * 86400000), end: w.start });
  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(url + '/research');
    assert.equal(await page.getAttribute('.nav a[aria-current="page"]', 'href'), '/research');
    await page.locator('#d-text', { hasText: 'Three exploits were recorded' }).waitFor();
    assert.equal(await page.textContent('#d-text strong'), '$6.4B', 'Markdown shown as text, safely');
    assert.match(await page.textContent('#d-note'), /Written by AI from the facts below only.*Written by test-model/s);
    assert.equal(await page.getAttribute('#d-facts-box', 'open'), null, 'the facts fold away under a written digest');
    await page.getByText('The facts it was written from').click();
    assert.match(await page.textContent('#d-facts'), /exploits recorded.*\[DefiLlama hacks\]/s);
    assert.equal(await page.locator('#d-pick option').count(), 2);
    console.log('✔ the latest digest, written from the facts, with the facts and their sources beneath');

    await page.selectOption('#d-pick', { index: 1 });
    await page.waitForFunction(() => document.getElementById('d-text').hidden);
    assert.notEqual(await page.getAttribute('#d-facts-box', 'open'), null, 'with no write-up, the facts are the digest, open');
    assert.match(await page.textContent('#d-note'), /The facts for the week, each with its source/);
    console.log('✔ an earlier week from the archive; one made without AI shows its facts');

    await page.locator('#h-stats .tile-stat').first().waitFor();
    assert.match(await page.textContent('#h-stats'), /Last 30 days\$6\.4B3 hacks/);
    assert.match(await page.textContent('#h-stats'), /Last 90 days.*4 hacks, 1 with no amount recorded/s);
    const rows = page.locator('#hacks tbody tr');
    assert.equal(await rows.count(), 4);
    assert.equal(await rows.nth(0).locator('a.name').getAttribute('href'), 'https://example.com/postmortem');
    assert.match(await rows.nth(3).textContent(), /Older Pool.*not recorded/s);
    await page.locator('#h-techs .bar-btn', { hasText: 'Withdrawal Logic Flaw' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#hacks tbody tr').length === 2);
    assert.match(await page.textContent('#h-msg'), /Showing: Withdrawal Logic Flaw/);
    await page.getByRole('button', { name: 'Show all' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#hacks tbody tr').length === 4);
    await page.selectOption('#h-days', '30');
    await page.waitForFunction(() => document.querySelectorAll('#hacks tbody tr').length === 3);
    console.log('✔ the hack tracker: totals per period, unrecorded amounts said so, filter by how, the source linked');

    await page.setViewportSize({ width: 375, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'no sideways scrolling at phone width');
    console.log('✔ fits a phone screen');
    assert.deepEqual(errors, []);
    console.log('all passed');
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

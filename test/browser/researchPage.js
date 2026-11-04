/**
 * Drives /research in a real browser against the real server, with
 * DefiLlama, the other desks, Claude and the email provider as stand-ins:
 * the published digests with their byline, the newsletter sign-up, the hack
 * tracker, and the owner's review of a draft. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/researchPage.js
 */
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
const ADMIN = '0x' + 'ad'.repeat(20);
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', ANTHROPIC_API_KEY: 'test', ADMIN_WALLETS: ADMIN, RESEND_API_KEY: 'test', OPERATOR_POSTAL_ADDRESS: '1 Test Street' });

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
  require('../../src/yield/rates').listRates = async () => [];
  require('../../src/services/governors').REGISTRY.length = 0;
  const sent = [];
  require('../../src/alerts/transports').email.send = async m => { sent.push(m); };
  const claude = require('../../src/ai/claude');
  claude.available = () => true;
  const WRITTEN = '## The week in brief\nThree exploits were recorded, **$6.4B** lost in all [DefiLlama hacks].\n## Hacks\n- Big Exchange lost $6.4B [DefiLlama hacks]';
  claude.write = async ({ system, prompt }) => ({ text: system.includes('fact-checker') ? `${prompt.split('Draft:\n')[1]}\n=== REMOVED ===\n- Expect more next week.` : WRITTEN });
  const research = require('../../src/services/research');
  const w = research.lastWeek(today);
  const week = d => d.toISOString().slice(0, 10);
  const { rows: [admin] } = await db.query('INSERT INTO accounts (wallet) VALUES ($1) RETURNING id, wallet', [ADMIN]);
  await research.makeDigest(w);
  await research.publish(week(w.start), { accountId: admin.id });
  claude.available = () => false;
  await research.makeDigest({ start: new Date(w.start - 7 * 86400000), end: w.start });
  await research.publish(week(new Date(w.start - 7 * 86400000)), { accountId: admin.id });
  claude.available = () => true;
  const older = { start: new Date(w.start - 14 * 86400000), end: new Date(w.start - 7 * 86400000) };
  await research.makeDigest(older); // left as a draft, for the owner to review
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
    assert.match(await page.textContent('#d-byline'), /^Written by RektBull Research · published /);
    assert.match(await page.textContent('#d-note'), /From the facts below, each with its source\. Not advice\./);
    assert.ok(!(await page.textContent('#digest-card')).includes('test-model'), 'no model named');
    assert.equal(await page.isHidden('#review'), true, 'the review is the owner\'s only');
    assert.equal(await page.getAttribute('#d-facts-box', 'open'), null, 'the facts fold away under a written digest');
    await page.getByText('The facts it was written from').click();
    assert.match(await page.textContent('#d-facts'), /exploits recorded.*\[DefiLlama hacks\]/s);
    assert.equal(await page.locator('#d-pick option').count(), 2, 'the draft isn\'t in the archive');
    console.log('✔ the latest published digest, with its byline, written from the facts, with the facts and their sources beneath');

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

    await page.fill('#n-email', 'reader@example.com');
    await page.getByRole('button', { name: 'Subscribe' }).click();
    await page.locator('#n-msg', { hasText: 'Check your inbox' }).waitFor();
    assert.equal(sent.at(-1).to, 'reader@example.com');
    assert.match(sent.at(-1).subject, /Confirm/);
    const confirmLink = sent.at(-1).text.match(/https?:\/\/\S+confirm\S+/)[0].replace(/^https?:\/\/[^/]+/, url);
    await page.goto(confirmLink);
    assert.match(page.url(), /\/research\?newsletter=confirmed#newsletter$/);
    await page.locator('#n-msg', { hasText: 'You\'re subscribed' }).waitFor();
    console.log('✔ the newsletter: sign up, confirm from the email, told so on the page');

    await page.setViewportSize({ width: 375, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'no sideways scrolling at phone width');
    console.log('✔ fits a phone screen');

    // The owner: the draft to review, edit and publish.
    const owner = await browser.newPage();
    owner.on('pageerror', e => errors.push(e.message));
    owner.on('dialog', d => d.accept());
    const token = require('../../src/auth/siwe').issueToken(admin);
    await owner.addInitScript(([t, a]) => { sessionStorage.setItem('rb_token', t); sessionStorage.setItem('rb_wallet', a); }, [token, ADMIN]);
    await owner.goto(url + '/research#review');
    await owner.locator('#r-body').waitFor();
    assert.match(await owner.inputValue('#r-text'), /^## The week in brief\nThree exploits were recorded/, 'the fact-checked draft, ready to edit');
    assert.match(await owner.textContent('#r-notes'), /The fact-check removed 1 sentence:.*Expect more next week\./s);
    assert.match(await owner.textContent('#r-mail'), /emails it to 1 confirmed subscriber \(0 not yet confirmed\)/);
    await owner.fill('#r-text', '## The week in brief\nAn **edited** week [DefiLlama hacks].');
    await owner.getByText('Preview', { exact: true }).click();
    assert.equal(await owner.textContent('#r-preview strong'), 'edited');
    await owner.getByRole('button', { name: 'Publish and email it' }).click();
    await owner.locator('#r-msg', { hasText: 'No draft waiting' }).waitFor();
    assert.equal(await owner.locator('#d-pick option').count(), 3, 'published: now in the archive');
    await owner.selectOption('#d-pick', week(older.start));
    await owner.locator('#d-text', { hasText: 'An edited week' }).waitFor();
    await owner.setViewportSize({ width: 375, height: 800 });
    assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= 375), 'the review fits a phone too');
    console.log('✔ the owner reviews the fact-checked draft, sees what was removed, edits it and publishes it');
    assert.deepEqual(errors, []);
    console.log('all passed');
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

/**
 * Drives /opportunities in a real browser against the real server, with
 * Merkl, DefiLlama and each desk's free check as stand-ins. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/opportunitiesPage.js
 */
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '' });

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  const now = Date.now();
  const RWD = '0x' + '11'.repeat(20);
  const C = (id, extra) => ({ id, chain: 'base', name: `Supply USDC to Vault ${id}`, action: 'LEND', type: 'X', apr_pct: 4.2, tvl_usd: 3e8, daily_rewards_usd: 30000, ends_at: new Date(now + 40 * 86400000).toISOString(), how: ['Lend assets on Safe Lend.', 'Rewards accumulate automatically.'], deposit_url: null, protocol: { id: 's', name: 'Safe Lend', url: 'https://safe.example', defillama_slug: 'safe-lend' }, tokens: [], rewards: [{ symbol: 'RWD', address: RWD, verified: true, test: false }], ...extra });
  const merkl = require('../../src/providers/merkl');
  merkl.live = async chain => (chain === 'base' ? [
    C('A'),
    C('B', { name: 'Provide liquidity to WETH/XYZ', action: 'POOL', apr_pct: 61.5, tvl_usd: 4e5, protocol: { id: 'd', name: 'Some Dex', url: 'https://dex.example', defillama_slug: 'some-dex' }, rewards: [{ symbol: 'XYZ', address: '0x' + '22'.repeat(20), verified: false, test: false }] }),
  ] : []);
  const llama = require('../../src/providers/llama');
  llama.protocols = async () => [
    { id: '1', name: 'Safe Lend', slug: 'safe-lend', audit_links: ['https://a'], listed_at: Math.floor(now / 1000) - 900 * 86400, tvl_doubted: false, change_7d: 1 },
    { id: '2', name: 'Some Dex', slug: 'some-dex', audit_links: [], listed_at: Math.floor(now / 1000) - 900 * 86400, tvl_doubted: false, change_7d: 1 },
  ];
  llama.hacks = async () => ({ 2: [{ date: '2023-07-30', amount_usd: 6.1e7, technique: 'Compiler Bug', returned_usd: null }] });
  require('../../src/services/approvals').preview = async () => ({ summary: { open: 9, to_revoke: 2, by_severity: { critical: 1, high: 0, medium: 1, low: 7 }, value_at_risk_usd: 1234.5, not_priced: 0, chains_read: ['base'], chains_not_read: [] } });
  require('../../src/services/claims').check = async () => ({ summary: { claimable: 2, claimable_usd: 41.2, not_priced: 0, chains: ['base'] }, sources: [{ name: 'Merkl rewards' }], not_checked: [], fee: { standard_rate: '5%', pro_rate: '3%' } });
  require('../../src/yield/proposals').summary = async () => ({ positions: [], idle: [{ chain: 'base', asset: 'USDC', usd: 900 }], total_in_positions_usd: 0, not_read: [], proposals_count: 1, extra_per_year_usd: 38.7 });
  require('../../src/services/governance').check = async () => ({ summary: { active: 2, to_vote: 1, closing_within_24h: 1, votes_counting_for_nobody: 0 }, not_checked: [], source: 'Snapshot hub' });
  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const WALLET = '0x' + '9a'.repeat(20);

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(url + '/opportunities');
    assert.equal(await page.getAttribute('.nav a[aria-current="page"]', 'href'), '/opportunities');
    assert.equal(await page.locator('.nav a[href="/find"]').count(), 0, 'Find money sits under Opportunities now');

    const camps = page.locator('#campaigns .camp');
    await camps.first().waitFor();
    assert.equal(await camps.count(), 2);
    const lp = camps.nth(1);
    assert.match(await lp.textContent(), /61\.5%.*extra rewards a year/s);
    assert.match(await lp.textContent(), /Some Dex: Hacked 2023-07-30: \$61M lost \(Compiler Bug\)/);
    assert.match(await lp.textContent(), /Providing liquidity: price moves between the two tokens/);
    assert.match(await lp.textContent(), /Reward token not verified by Merkl: XYZ/);
    assert.equal(await camps.nth(0).getByRole('link', { name: 'Check RWD' }).getAttribute('href'), `/safety?chain=base&token=${RWD}`);
    assert.equal(await camps.nth(0).getByRole('link', { name: /Go to Safe Lend/ }).getAttribute('href'), 'https://safe.example');
    assert.match(await page.textContent('#c-src'), /on top of the pool's own yield/);
    await page.selectOption('#c-sort', 'apr');
    await page.waitForFunction(() => document.querySelector('#campaigns .camp strong').textContent.startsWith('Provide liquidity'));
    await page.selectOption('#c-action', 'lend');
    await page.waitForFunction(() => document.querySelectorAll('#campaigns .camp').length === 1);
    console.log('✔ live reward campaigns: rate, money, rewards, end; the protocol\'s record, the action\'s risk, an unverified reward; sorted and filtered');

    await page.fill('#o-wallet', WALLET);
    await page.getByRole('button', { name: 'Check for free' }).click();
    await page.locator('#part-claims').waitFor();
    assert.match(await page.textContent('#o-guard'), /Before you claim anything: 2 approvals worth revoking, of 9 open/);
    assert.equal(await page.getAttribute('#o-guard a', 'href'), `/safety?wallet=${WALLET.toLowerCase()}#approvals-card`);
    assert.deepEqual(await page.locator('#o-parts .part').evaluateAll(els => els.map(e => e.id)), ['part-claims', 'part-yield', 'part-governance']);
    assert.match(await page.textContent('#part-claims'), /2 unclaimed rewards worth \$41\.20/);
    console.log('✔ your opportunities: claim, earn more and vote, with a warning first when apps can still take from the wallet');

    assert.deepEqual(await page.locator('#desks-card a.tile').evaluateAll(els => els.map(e => e.getAttribute('href'))), ['/find', '/find#yield-card', '/governance']);
    await page.goto(url + '/find');
    assert.equal(await page.getAttribute('.nav a[aria-current="page"]', 'href'), '/opportunities');
    assert.equal(await page.getAttribute('.pagehead .eyebrow a', 'href'), '/opportunities');
    console.log('✔ claim, earn and vote lead to Find money and Governance, which sit under Opportunities');

    await page.goto(url + '/opportunities');
    await page.locator('#campaigns .camp').first().waitFor();
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

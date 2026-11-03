/**
 * Drives / in a real browser against the real server, with the chains and
 * each desk's free check as stand-ins. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/homePage.js
 */
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '' });

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  const home = require('../../src/services/home');
  const WALLET = '0x' + '9a'.repeat(20);
  const TOKEN = '0x' + '1b'.repeat(20);
  const GOV = '0x' + '2c'.repeat(20);
  home.readChain = async (chain, address) => {
    if (address === TOKEN && chain === 'base') return { chain, kind: 'token', name: 'Test Dollar', symbol: 'TUSD', decimals: 6, total_supply: '1000.0' };
    if (address === GOV && chain === 'arbitrum') return { chain, kind: 'governor', name: 'Test DAO Governor' };
    if (chain === 'bsc') throw new Error('every endpoint failed');
    return { chain, kind: 'none' };
  };
  require('../../src/services/approvals').preview = async () => ({ summary: { open: 9, to_revoke: 2, by_severity: { critical: 1, high: 0, medium: 1, low: 7 }, value_at_risk_usd: 1234.5, not_priced: 0, chains_read: ['base'], chains_not_read: [{ chain: 'bsc', reason: 'no explorer answered' }] } });
  require('../../src/services/claims').check = async () => ({ summary: { claimable: 2, claimable_usd: 41.2, not_priced: 0, chains: ['base'] }, sources: [{ name: 'Merkl rewards' }], not_checked: [], fee: { standard_rate: '5%', pro_rate: '3%' } });
  require('../../src/yield/proposals').summary = async () => ({ positions: [], idle: [{ chain: 'base', asset: 'USDC', usd: 900 }], total_in_positions_usd: 0, not_read: [], proposals_count: 1, extra_per_year_usd: 38.7 });
  require('../../src/services/governance').check = async () => { throw new Error('Snapshot hub didn\'t answer'); };
  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(url + '/');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.card')).borderTopWidth), '1px', 'the stylesheet loaded');
    await page.locator('#p-find', { hasText: '5% of what you claim (3% with Safety Pro)' }).waitFor();
    const pricing = await page.textContent('#pricing');
    assert.match(pricing, /30 free points a month/);
    assert.match(pricing, /Safety Pro: \$9\.00 for 30 days or \$79\.00 a year/);
    assert.match(pricing, /0\.1% of each yield move/);
    console.log('✔ the desks and what they cost, from the catalog');

    // A wallet: what it is, then the free checkup from every desk.
    await page.fill('#ask', WALLET);
    await page.getByRole('button', { name: 'Check for free' }).click();
    await page.locator('#part-approvals', { hasText: '2 approvals worth revoking, of 9 open' }).waitFor();
    const found = await page.textContent('#ask-result');
    assert.match(found, /A wallet: there's no contract at this address on Ethereum, Base, Arbitrum, Optimism, Polygon/);
    assert.match(found, /Not read: BNB Chain \(every endpoint failed\)/);
    assert.match(found, /Source: Each chain's RPC/);
    const approvals = page.locator('#part-approvals');
    assert.match(await approvals.textContent(), /They could take\$1,234\.50/);
    assert.equal(await approvals.getAttribute('class'), 'part bad');
    await approvals.getByText('Couldn\'t check 1 thing').click();
    assert.match(await approvals.textContent(), /approvals on BNB Chain: no explorer answered/);
    assert.equal(await approvals.locator('a.go').getAttribute('href'), `/safety?wallet=${WALLET}#approvals-card`);
    assert.match(await page.textContent('#part-claims'), /2 unclaimed rewards worth \$41\.20/);
    assert.match(await page.textContent('#part-yield'), /Could earn about \$38\.70 more a year/);
    const gov = await page.textContent('#part-governance');
    assert.match(gov, /Couldn't be checked just now/);
    assert.match(gov, /Snapshot hub didn't answer/);
    console.log('✔ a wallet: the free checkup from every desk, each with its source, and the one that failed says why');

    // A token: sent to the safety check, which opens filled in.
    await page.fill('#ask', TOKEN);
    await page.getByRole('button', { name: 'Check for free' }).click();
    await page.locator('#ask-result', { hasText: 'A token on Base' }).waitFor();
    assert.ok(await page.locator('#checkup-card').isHidden(), 'no checkup for a token');
    assert.match(await page.textContent('#ask-result'), /Base: a token: Test Dollar \(TUSD\)/);
    await page.getByRole('link', { name: /Check TUSD on Base before you buy it/ }).click();
    await page.waitForURL(/\/safety\?chain=base/);
    await page.waitForFunction(t => document.getElementById('token').value === t && document.getElementById('chain').value === 'base', TOKEN);
    console.log('✔ a token: opens the safety check, filled in (checking is still a click)');

    // A governor: opens the add-a-governor form, filled in.
    await page.goto(url + '/?q=' + GOV);
    await page.locator('#ask-result', { hasText: 'A DAO governor contract on Arbitrum' }).waitFor();
    await page.getByRole('link', { name: /Follow Test DAO Governor on Arbitrum/ }).click();
    await page.waitForURL(/\/governance\?chain=arbitrum/);
    assert.equal(await page.inputValue('#gv-address'), GOV);
    assert.equal(await page.inputValue('#gv-chain'), 'arbitrum');
    console.log('✔ a governor (from a link): opens the governance page with the governor filled in');

    await page.goto(url + '/');
    await page.fill('#ask', 'vitalik.eth');
    await page.getByRole('button', { name: 'Check for free' }).click();
    await page.locator('#ask-msg', { hasText: 'paste the address' }).waitFor();
    console.log('✔ anything but an address is refused, saying what to paste');

    await page.goto(url + '/?q=' + WALLET);
    await page.locator('#part-yield').waitFor();
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

/**
 * Drives /portfolio in a real browser against the real server, with the
 * portfolio read as a stand-in (test/portfolio.test.js covers the read).
 * Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/portfolioPage.js
 */
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '' });

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  const W = '0x' + 'aa'.repeat(20);
  const FAKE = '0x' + 'f0'.repeat(20);
  const asked = [];
  require('../../src/services/portfolio').portfolio = async wallet => {
    asked.push(wallet);
    return {
      wallet, read_at: new Date().toISOString(), total_usd: 7628, tokens_usd: 6628, defi_usd: 1000, stable_pct: 34,
      by_chain: [{ chain: 'base', chain_name: 'Base', usd: 6628 }, { chain: 'ethereum', chain_name: 'Ethereum', usd: 1000 }],
      holdings: [
        { kind: 'native', chain: 'base', chain_name: 'Base', symbol: 'ETH', name: 'ETH', address: null, amount: 2, price: 2500, usd: 5000, share_pct: 65.5, signals: [], check: null },
        { kind: 'token', chain: 'base', chain_name: 'Base', symbol: 'USDE', name: 'Ethena USDe', address: '0x' + 'f4'.repeat(20), amount: 100, price: 0.97, usd: 97, share_pct: 1.3, signals: [{ level: 'bad', text: 'Off its peg by 3.0% (price $0.9700)', source: 'DefiLlama price' }], check: '/safety?chain=base&token=0xf4' },
      ],
      positions: [{ kind: 'position', chain: 'ethereum', chain_name: 'Ethereum', protocol: 'Aave v3', symbol: 'USDC', amount: 1000, usd: 1000, signals: [] }],
      unpriced: [{ kind: 'token', chain: 'base', chain_name: 'Base', symbol: 'USDC', name: 'USD Coin', address: FAKE, amount: 5000, price: 1, usd: 5000, signals: [{ level: 'bad', text: 'Named USDC but isn\'t the real USDC contract on Base: a common scam airdrop. Don\'t approve, swap or send it.', source: 'RektBull\'s list of major token contracts' }], check: `/safety?chain=base&token=${FAKE}` }],
      risk: { to_revoke: 1, open: 4, value_at_risk_usd: 1500, href: `/safety?wallet=${wallet}#approvals-card` }, flagged: 2,
      not_read: [{ chain: 'bsc', what: 'tokens beyond the major ones', reason: 'the explorer didn\'t answer' }],
      sources: ['Token transfers from the chain explorers', 'Prices from DefiLlama'], note: 'Values are at DefiLlama\'s current prices.',
    };
  };
  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(url + '/portfolio');
    assert.equal(await page.getAttribute('.nav a[aria-current="page"]', 'href'), '/portfolio');
    await page.fill('#p-wallet', W);
    await page.getByRole('button', { name: 'Read it' }).click();
    await page.locator('#p-result').waitFor();
    assert.equal(await page.textContent('#s-total'), '$7.6K');
    assert.equal(await page.textContent('#s-stable'), '34%');
    assert.match(await page.textContent('#p-risk'), /1 approval worth revoking.*could take \$1\.5K.*2 holdings are flagged below/s);
    assert.equal(await page.getAttribute('#p-risk a', 'href'), `/safety?wallet=${W}#approvals-card`);
    assert.equal(await page.locator('#by-chain .bar-row').count(), 2);
    console.log('✔ the overview: total, tokens, DeFi, stablecoins; approvals at risk first; each chain\'s share');

    const rows = await page.locator('#holdings tbody tr').allTextContents();
    assert.match(rows[0], /ETH.*Base.*\$5K.*65\.5%/s);
    assert.match(rows[1], /USDE.*Off its peg by 3\.0%/s);
    assert.match(await page.textContent('#positions'), /USDC on Aave v3/);
    assert.ok(await page.locator('#unpriced').isHidden(), 'unpriced tokens folded away');
    assert.match(await page.textContent('#unpriced-card'), /Tokens you didn't buy are often scam airdrops/);
    await page.getByText('Show them').click();
    assert.match(await page.textContent('#unpriced'), /Named USDC but isn't the real USDC contract/);
    assert.match(await page.textContent('#notread-sum'), /Couldn't read 1 thing/);
    assert.equal(await page.getAttribute('#n-opps', 'href'), `/opportunities?wallet=${W}`);
    console.log('✔ holdings with their facts, DeFi positions, lookalikes kept apart and folded away, what couldn\'t be read');

    await page.goto(`${url}/portfolio?wallet=${W}`);
    await page.locator('#p-result').waitFor();
    assert.equal(asked.length, 2, 'a link with ?wallet= reads it straight away');
    await page.setViewportSize({ width: 375, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'no sideways scrolling at phone width');
    console.log('✔ a shared link reads the wallet; fits a phone screen');
    assert.deepEqual(errors, []);
    console.log('all passed');
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

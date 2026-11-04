/**
 * Drives /markets in a real browser against the real server, with DefiLlama
 * and CoinGecko as stand-ins. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/marketsPage.js
 */
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '' });

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  const llama = require('../../src/providers/llama');
  const days = Array.from({ length: 120 }, (_, i) => ({ date: new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString().slice(0, 10), tvl: 80e9 + (i % 10) * 1e9 }));
  llama.tvlHistory = async () => days;
  llama.dexVolume = async () => ({ total_24h: 8.27e9, change_1d: -10.1 });
  llama.fees = async () => ({ protocols: {}, total_24h: 6.62e7, change_1d: 0.3 });
  const S = (symbol, extra) => ({ id: symbol, name: symbol + ' coin', symbol, peg: 'USD', mechanism: 'fiat-backed', price: 1, supply: 1e9, supply_prev_week: 1e9, supply_prev_month: 1e9, chains: 3, ...extra });
  llama.stablecoins = async () => [S('USDT', { supply: 178e9, price: 0.9986 }), S('WOBBLY', { supply: 5e8, price: 0.97, supply_prev_week: 7e8 }), S('ALGO', { mechanism: 'algorithmic', supply: 6e8, supply_prev_week: 6e8, price: null })];
  const P = (id, name, category, extra) => ({ id, name, slug: name.toLowerCase(), category, chains: ['ethereum'], chain_count: 1, tvl: 1e9, chain_tvl: { ethereum: 1e9 }, change_7d: 3, audit_links: ['https://a'], listed_at: 1600000000, url: null, token: null, tvl_doubted: false, ...extra });
  llama.protocols = async () => [P('1', 'Treasury Fund', 'RWA', { tvl: 2e9, chain_tvl: { ethereum: 2e9 } }), P('2', 'Credit Pool', 'RWA', { audit_links: [] }), P('3', 'Polymarket-like', 'Prediction Market'), P('4', 'Some Dex', 'Dexs')];
  llama.hacks = async () => ({});
  require('../../src/providers/coingecko').topTokens = async () => [
    { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', rank: 1, price_usd: 78590, change_24h_pct: 2, change_7d_pct: -3.6, market_cap_usd: 1.58e12, volume_24h_usd: 3.1e10, from_ath_pct: -37 },
    { id: 'dogecoin', symbol: 'DOGE', name: 'Dogecoin', rank: 9, price_usd: 0.0712, change_24h_pct: 1, change_7d_pct: -5, market_cap_usd: 1e10, volume_24h_usd: 1e9, from_ath_pct: -90, ath_date: '2021-05-07' },
  ];
  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  const loaded = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => loaded.push(r.url()));
  try {
    await page.goto(url + '/markets');
    await page.locator('#t-tvl strong', { hasText: '$' }).waitFor();
    assert.match(await page.textContent('#t-dex'), /\$8\.3B.*-10\.1%/s);
    assert.match(await page.textContent('#t-stables'), /\$179B/);
    assert.match(await page.textContent('#overview-src'), /DefiLlama/);
    assert.ok(!loaded.some(u => u.includes('ethers')), 'the page doesn\'t load ethers');
    console.log('✔ DeFi today: TVL, DEX volume, fees and stablecoin supply, each with its source; no ethers download');

    const plot = page.locator('#tvl-plot');
    assert.equal(await plot.locator('path.line').count(), 1);
    await plot.scrollIntoViewIfNeeded();
    const box = await plot.boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
    await plot.locator('.tip').waitFor();
    assert.match(await plot.locator('.tip').textContent(), /: \$\d+B/);
    await plot.focus();
    await page.keyboard.press('ArrowLeft');
    assert.match(await plot.locator('.tip').textContent(), /\$/);
    assert.equal(await page.locator('#tvl-table tbody tr').count(), 90, 'a table view of the chart\'s numbers');
    console.log('✔ the TVL chart: one line, a readout on hover and with the arrow keys, and its numbers as a table');

    await page.locator('#stables tbody tr').first().waitFor();
    const rows = await page.locator('#stables tbody tr').allTextContents();
    assert.match(rows[0], /USDT.*On its peg \(price \$0\.9986\)/s);
    assert.match(rows.find(r => r.includes('WOBBLY')), /Off its peg by 3\.0%.*Supply down 29% in a week/s);
    assert.match(rows.find(r => r.includes('ALGO')), /No price recorded.*Algorithmic/s);
    assert.match(await page.textContent('#s-facts'), /Backed by algorithmic \(no reserves\)/);
    console.log('✔ stablecoins: peg, backing and people leaving, each fact with its source');

    await page.locator('#rwa tbody tr').first().waitFor();
    assert.deepEqual(await page.locator('#rwa tbody .name').allTextContents(), ['Treasury Fund', 'Credit Pool']);
    assert.match(await page.textContent('#rwa'), /No audit listed/);
    assert.deepEqual(await page.locator('#pm tbody .name').allTextContents(), ['Polymarket-like']);
    console.log('✔ real-world assets and prediction markets, with Discover\'s safety facts');

    await page.locator('#tokens tbody tr').first().waitFor();
    assert.match(await page.textContent('#tokens'), /DOGE.*90% below its high \(2021-05-07\)/s);
    assert.equal(await page.getAttribute('#tokens-src a', 'href'), 'https://www.coingecko.com/');
    console.log('✔ the largest tokens, attributed to CoinGecko');

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

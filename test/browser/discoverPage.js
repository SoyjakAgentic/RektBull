/**
 * Drives /discover in a real browser against the real server, with
 * DefiLlama, GeckoTerminal and GoPlus as stand-ins. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/discoverPage.js
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
  const llama = require('../../src/providers/llama');
  const P = (id, name, extra) => ({ id, name, slug: name.toLowerCase().replace(/ /g, '-'), category: 'Lending', chains: ['ethereum', 'base'], chain_count: 2, tvl: 1e9, chain_tvl: { ethereum: 7e8, base: 3e8 }, change_7d: 2.5, audit_links: ['https://a'], listed_at: Math.floor(now / 1000) - 400 * 86400, url: 'https://x', token: null, tvl_doubted: false, ...extra });
  llama.protocols = async () => [
    P('1', 'Big Lend', { tvl: 5e9, chain_tvl: { ethereum: 4e9, base: 1e9 }, token: { chain: 'ethereum', address: '0x' + '11'.repeat(20) } }),
    P('2', 'Base Dex', { category: 'Dexs', chains: ['base'], chain_count: 1, tvl: 2e9, chain_tvl: { base: 2e9 }, change_7d: -40 }),
    P('4', 'Hacked Bridge', { category: 'Bridge', tvl: 3e9, chain_tvl: { ethereum: 3e9 } }),
  ];
  llama.fees = async () => ({ 1: { total: 50000, chains: { ethereum: 30000, base: 20000 } }, 2: { total: 90000, chains: { base: 90000 } } });
  llama.hacks = async () => ({ 4: [{ date: '2022-02-02', amount_usd: 326e6, technique: 'Signature Verification Flaw', returned_usd: null }] });
  llama.chains = async () => [{ name: 'Ethereum', tvl: 4e10, token: 'ETH', rektbull: 'ethereum' }, { name: 'Base', tvl: 6e9, token: null, rektbull: 'base' }, { name: 'Tron', tvl: 5e9, token: 'TRX', rektbull: null }];
  const gt = require('../../src/providers/geckoterminal');
  const asked = [];
  const TOK = '0x' + 'ab'.repeat(20);
  gt.pools = async (list, chain) => {
    asked.push(`${list}:${chain}`);
    return [{ pool: '0xp', name: 'SCAM / WETH', dex: 'uniswap', token: { address: TOK, symbol: 'SCAM', name: 'Scam Coin' }, quote: 'WETH', price_usd: 0.0012, change_24h_pct: 850, volume_24h_usd: 2e5, liquidity_usd: 12000, created_at: new Date(now - 5 * 3600000).toISOString(), buys_24h: 140, sells_24h: 0 }];
  };
  require('../../src/services/tokenRisk').goplus = async () => ({ honeypot: true, sell_tax_pct: 0, buy_tax_pct: 0, proxy: false });
  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(url + '/discover');
    assert.equal(await page.getAttribute('.nav a[aria-current="page"]', 'href'), '/discover');
    const rows = page.locator('#dapps tbody tr');
    await rows.first().waitFor();
    assert.deepEqual(await page.locator('#dapps tbody .name').allTextContents(), ['Big Lend', 'Hacked Bridge', 'Base Dex']);
    const hacked = await rows.nth(1).textContent();
    assert.match(hacked, /Hacked 2022-02-02: \$326M lost \(Signature Verification Flaw\)/);
    assert.equal(await rows.nth(0).locator('a.act').getAttribute('href'), `/safety?chain=ethereum&token=0x${'11'.repeat(20)}`);
    assert.equal(await rows.nth(1).locator('.sig.bad').getAttribute('title'), 'Source: DefiLlama hacks');
    assert.match(await page.textContent('#dapps-src'), /not whether it is safe/);
    console.log('✔ dapps ranked by TVL, with hacks, audits and the source of each fact; "Check its token" leads to the quick check');

    await page.selectOption('#f-chain', 'base');
    await page.selectOption('#f-sort', 'fees');
    await page.locator('#dapps tbody .name', { hasText: 'Base Dex' }).first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#dapps tbody tr').length === 2);
    assert.deepEqual(await page.locator('#dapps tbody .name').allTextContents(), ['Base Dex', 'Big Lend']);
    assert.match(await rows.nth(0).textContent(), /\$90K/);
    assert.match(await rows.nth(0).textContent(), /TVL down 40% in a week/);
    await page.locator('#cats tbody tr', { hasText: 'Dexs' }).waitFor();
    console.log('✔ on Base, ranked by fees: each dapp\'s Base TVL and fees; categories follow the chain');

    const tok = page.locator('.tok').first();
    await tok.waitFor();
    assert.match(await tok.textContent(), /Buys\/sells 24h 140\/0/);
    assert.match(await tok.textContent(), /140 buys and no sells in 24 hours/);
    assert.match(await tok.textContent(), /Pool opened 5 hours ago/);
    await tok.getByRole('button', { name: 'Free flags' }).click();
    await tok.locator('.flagbox', { hasText: 'Flagged as a honeypot' }).waitFor();
    assert.equal(await tok.getByRole('link', { name: 'Quick check' }).getAttribute('href'), `/safety?chain=base&token=${TOK}`);
    await page.getByRole('button', { name: 'New launches' }).click();
    await page.getByRole('button', { name: 'Solana' }).click();
    await page.waitForFunction(() => document.getElementById('tokens-note').textContent.includes('most scams start'));
    assert.deepEqual(asked, ['trending:base', 'new:base', 'new:solana']);
    console.log('✔ tokens: the warning signs from their own trading, GoPlus\'s flags on request, the quick check a click away');

    await page.locator('#chains tbody tr', { hasText: 'Tron' }).waitFor();
    assert.match(await page.textContent('#chains'), /Its dapps/);
    await page.fill('#d-q', TOK);
    await page.press('#d-q', 'Enter');
    await page.waitForURL(u => u.pathname === '/' && u.search.includes(TOK));
    console.log('✔ chains, and the check box hands an address to Home\'s lookup');

    await page.goto(url + '/discover');
    await page.locator('#dapps tbody tr').first().waitFor();
    await page.setViewportSize({ width: 375, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'no sideways scrolling at phone width (tables scroll in their own box)');
    console.log('✔ fits a phone screen');
    assert.deepEqual(errors, []);
    console.log('all passed');
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

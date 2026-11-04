/**
 * Drives /agents in a real browser against the real server, with the x402
 * Bazaar, GoPlus and DefiLlama as stand-ins: services ranked by payers with
 * their signals, the payment address linked to the lookup, filters, the
 * AI-agent protocols, and the menu (one row on a laptop). No database needed.
 *
 *   node test/browser/agentsPage.js
 */
const assert = require('node:assert/strict');

Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: '' });

(async () => {
  const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const item = (url, service, payers, calls, extra = {}) => ({
    resource: url, serviceName: service, description: `${service}: answers questions for agents`, tags: extra.tags || [],
    accepts: [{ network: extra.network || 'eip155:8453', asset: extra.asset || BASE_USDC, amount: extra.amount || '5000', payTo: extra.payTo || '0x' + '11'.repeat(20) }],
    quality: { l30DaysTotalCalls: calls, l30DaysUniquePayers: payers, lastCalledAt: new Date(Date.now() - 3600000 * 5).toISOString() },
  });
  const bazaar = require('../../src/providers/x402bazaar');
  const items = [
    item('https://api.search.example/web', 'Search Co', 300, 90000, { tags: ['search'] }),
    item('https://busy.example/q', 'Busy Looking', 490, 495),
    item('https://drainy.example/d', 'Drainy', 60, 2000, { payTo: '0x' + 'dd'.repeat(20) }),
    item('https://sol.example/p', 'Sol Prices', 40, 800, { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: 'So1anaPayTo111111111111111111111111111111111', tags: ['prices'] }),
  ];
  bazaar.listing = async () => ({ endpoints: items.map(bazaar.endpoint).filter(Boolean), listed_total: 114274, read: 500, read_at: new Date(Date.now() - 3600000).toISOString() });
  require('../../src/providers/goplus').addressRisk = async (_c, a) => ({ source: 'GoPlus', flags: a === '0x' + 'dd'.repeat(20) ? ['Phishing activities'] : [] });
  require('../../src/services/discover').dapps = async ({ sort }) => ({
    total: 2, not_checked: [], sources: ['DefiLlama protocols', 'DefiLlama hacks'], note: 'A ranking shows how much is in a dapp, not whether it is safe.',
    dapps: (sort === 'fees' ? [1, 0] : [0, 1]).map(i => [
      { name: 'Agent Launchpad', category: 'AI Agents', tvl_usd: 3.2e8, change_7d_pct: -4.2, fees_24h_usd: 1.2e5, chains: ['Base'], listed_since: '2024-10-01', signals: [{ level: 'ok', text: 'No hack recorded', source: 'DefiLlama hacks' }], links: { defillama: 'https://defillama.com/protocol/agent-launchpad' }, token: { chain: 'base', address: '0x' + '44'.repeat(20), check: `/safety?chain=base&token=0x${'44'.repeat(20)}` } },
      { name: 'Agent Index', category: 'AI Agents', tvl_usd: 4e7, change_7d_pct: 12, fees_24h_usd: 3e5, chains: ['Solana'], listed_since: null, signals: [{ level: 'warn', text: 'No audit listed', source: 'DefiLlama protocols' }], links: { defillama: 'https://defillama.com/protocol/agent-index' }, token: null },
    ][i]),
  });

  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(url + '/agents');
    assert.equal(await page.getAttribute('.nav a[aria-current="page"]', 'href'), '/agents');
    assert.equal(await page.evaluate(() => Math.round(document.querySelector('header').getBoundingClientRect().height)), 65, 'the menu stays one row on a laptop');

    const rows = page.locator('#x-table tbody tr');
    await rows.nth(3).waitFor();
    assert.deepEqual(await rows.locator('.name').allTextContents(), ['Busy Looking', 'Search Co', 'Drainy', 'Sol Prices'], 'ranked by payers');
    assert.match(await rows.nth(0).textContent(), /495 calls from 490 different payers in 30 days, about one each/);
    const drainy = rows.nth(2);
    assert.equal(await drainy.locator('.sig.bad').textContent(), 'GoPlus flags the address it\'s paid to (0xdddd…dddd on base): Phishing activities');
    assert.equal(await drainy.locator('a.mono').getAttribute('href'), `/?q=0x${'dd'.repeat(20)}`, 'the payment address goes to the lookup');
    assert.match(await rows.nth(1).textContent(), /\$0\.005.*300.*90,000.*Base/s);
    assert.match(await page.textContent('#x-stats'), /Services with real users4.*Listed endpoints114,274.*Signals in this list21 flagged payment address, 1 with usage that looks generated/s);
    assert.match(await page.textContent('#x-src'), /Coinbase x402 Bazaar.*RektBull hasn't tested any/);
    console.log('✔ x402 services ranked by real payers, with signals; a flagged payment address in red, linked to the lookup');

    await page.selectOption('#x-net', 'solana');
    await page.waitForFunction(() => document.querySelectorAll('#x-table tbody tr').length === 1);
    assert.equal(await rows.locator('.name').textContent(), 'Sol Prices');
    await page.selectOption('#x-net', '');
    await page.fill('#x-q', 'search');
    await page.waitForFunction(() => document.querySelectorAll('#x-table tbody tr').length === 1 && document.querySelector('#x-table .name').textContent === 'Search Co');
    console.log('✔ filter by network, search');

    const prot = page.locator('#p-table tbody tr');
    await prot.nth(1).waitFor();
    assert.match(await prot.nth(0).textContent(), /Agent Launchpad.*\$320M.*-4\.2%.*No hack recorded.*Check its token/s);
    await page.selectOption('#p-sort', 'fees');
    await page.waitForFunction(() => document.querySelector('#p-table tbody tr .name').textContent === 'Agent Index');
    console.log('✔ the AI-agent protocols with their record, sortable');

    assert.equal(await page.getAttribute('#yours a.tile >> nth=0', 'href'), '/developers#mcp');
    await page.setViewportSize({ width: 375, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'no sideways scrolling at phone width');
    console.log('✔ fits a phone screen');
    assert.deepEqual(errors, []);
    console.log('all passed');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(err => { console.error(err); process.exit(1); });

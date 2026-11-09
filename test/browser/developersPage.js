/**
 * Drives /developers in a real browser against the real server: the MCP
 * address and setup, the tools listed by asking the MCP server itself, the
 * x402 prices from the catalog, and the API reference. No database needed.
 *
 *   node test/browser/developersPage.js
 */
const assert = require('node:assert/strict');

Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: '' });

(async () => {
  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(url + '/developers');
    assert.equal(await page.getAttribute('.nav a[aria-current="page"]', 'href'), '/developers');
    assert.equal(await page.textContent('#mcp-url'), `${url}/mcp`);
    assert.match(await page.textContent('#mcp-cc'), new RegExp(`claude mcp add --transport http[\\s\\\\]*rektbull ${url}/mcp`));
    assert.deepEqual(JSON.parse(await page.textContent('#mcp-json')), { mcpServers: { rektbull: { url: `${url}/mcp` } } });

    await page.locator('#mcp-tools tbody tr').nth(17).waitFor();
    assert.equal(await page.locator('#mcp-tools tbody tr').count(), 18);
    assert.match(await page.textContent('#mcp-count'), /18, from the server's own tools\/list/);
    const checkup = page.locator('#mcp-tools tbody tr', { hasText: 'wallet_checkup' });
    assert.match(await checkup.textContent(), /Wallet checkup.*3 \(10 signed in\)$/s);
    assert.match(await page.locator('#mcp-tools tbody tr', { hasText: 'markets_overview' }).textContent(), /Cached, no daily cap$/);
    console.log('✔ the MCP server: its address, setup for Claude, Claude Code and others, and its tools as the server lists them');

    const prices = page.locator('#prices tbody tr');
    assert.equal(await prices.count(), 7);
    assert.match(await prices.nth(0).textContent(), /POST \/v1\/tokens\/quick-check\$0\.251$/);
    assert.match(await prices.nth(1).textContent(), /\$3\.00over \$1/);
    assert.match(await prices.nth(2).textContent(), /POST \/v1\/contracts\/audit\$99\.00over \$1/, 'the contract audit: $99, above most x402 clients\' default cap');
    assert.match(await prices.nth(3).textContent(), /POST \/v1\/launch\/check\$0\.502$/, 'the launch check: $0.50 or 2 points');
    console.log('✔ x402: how it works, and the prices from the catalog');

    const groups = page.locator('.ref-group');
    assert.equal(await groups.count(), 3);
    assert.match(await groups.nth(0).locator('h3').textContent(), /Free, no account/);
    const portfolio = groups.nth(0).locator('tr', { hasText: '/v1/portfolio' });
    assert.match(await portfolio.textContent(), /wallet required An EVM wallet address.*5 \(30 signed in\)/s);
    assert.match(await groups.nth(2).locator('tr', { hasText: '/v1/me' }).textContent(), /sign in/);
    assert.equal(await page.getAttribute('#openapi-link', 'href'), '/v1/openapi.json');
    const doc = await (await page.request.get(url + '/v1/openapi.json')).json();
    assert.equal(doc.openapi, '3.1.0');
    console.log('✔ the API reference, grouped, with inputs, allowances and prices; the OpenAPI document');

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

/**
 * The MCP server and the API reference: the protocol (version negotiation,
 * notifications, what's refused), the tools (read-only, input checked before
 * any allowance is used, errors a model can read, the same daily allowance
 * as the website), and the reference (every documented endpoint is a real
 * route, every paid one priced from the catalog, the OpenAPI document).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', PUBLIC_URL: 'https://rektbull.test', ...(DB ? { DATABASE_URL: DB } : {}) });
const tools = require('../src/mcp/tools');
const api = require('../src/developers/api');

let server, base;
test.before(async () => {
  if (DB) {
    const db = require('../src/config/db');
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await require('../src/config/migrate').migrate();
  }
  server = require('../src/app').createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); if (DB) await require('../src/config/db').getPool().end(); });

const rpc = async (body, headers = {}) => {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
};
const call = (name, args, id = 7) => rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('the protocol: initialize, versions, notifications, and what is refused', async () => {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-06-18', 'a version we speak is kept');
  assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.body.result.serverInfo.name, 'rektbull');
  assert.match(init.body.result.instructions, /never present a token, dapp or campaign as safe/);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } })).body.result.protocolVersion, '2025-11-25', 'otherwise our latest');

  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.deepEqual((await rpc({ jsonrpc: '2.0', id: 2, method: 'ping' })).body, { jsonrpc: '2.0', id: 2, result: {} });
  assert.equal((await rpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' })).body.error.code, -32601);
  assert.equal((await rpc([{ jsonrpc: '2.0', id: 4, method: 'ping' }])).status, 400, 'one message per request');
  assert.equal((await rpc({ id: 5, method: 'ping' })).status, 400, 'JSON-RPC 2.0 only');
  assert.equal((await rpc({ jsonrpc: '2.0', id: 6, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).status, 400);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 6, method: 'ping' }, { 'mcp-protocol-version': '2025-06-18' })).status, 200);
  const get = await fetch(base + '/mcp');
  assert.deepEqual([get.status, get.headers.get('allow')], [405, 'POST'], 'no stream, no session');
  const pre = await fetch(base + '/mcp', { method: 'OPTIONS', headers: { origin: 'https://agent.example', 'access-control-request-method': 'POST' } });
  assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin')], [204, '*']);
  assert.match(pre.headers.get('access-control-allow-headers'), /mcp-protocol-version/);
});

test('the tools: listed with schemas, all read-only, each allowance stated', async () => {
  const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const listed = body.result.tools;
  assert.deepEqual(listed.map(t => t.name), Object.keys(tools.TOOLS));
  for (const t of listed) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.title && t.description.length > 40, t.name);
    assert.deepEqual([t.annotations.readOnlyHint, t.annotations.destructiveHint], [true, false], `${t.name} is read-only`);
  }
  const checkup = listed.find(t => t.name === 'wallet_checkup');
  assert.deepEqual(checkup._meta['com.rektbull/free_per_day'], { account: 10, anonymous: 3 });
  assert.equal(listed.find(t => t.name === 'markets_overview')._meta, undefined, 'cached data has no daily cap');
  assert.ok(!listed.some(t => /(^|_)(prepare|send|sign|revoke|trade|move|vote|claim)(_|$)/.test(t.name)), 'nothing that moves money: no tool prepares, signs or sends');
});

test('a call: the result with its sources, input refused before anything runs, errors a model can read', async () => {
  const markets = require('../src/services/markets');
  markets.overview = async () => ({ tvl: { usd: 85e9, change_7d_pct: -0.9 }, sources: { tvl: 'DefiLlama TVL' }, not_checked: [] });
  const ok = await call('markets_overview', {});
  assert.equal(ok.body.result.isError, false);
  assert.deepEqual(ok.body.result.structuredContent.sources, { tvl: 'DefiLlama TVL' });
  assert.deepEqual(JSON.parse(ok.body.result.content[0].text), ok.body.result.structuredContent, 'the same result as text, for clients without structured content');

  const research = require('../src/services/research');
  let ran = false;
  research.hacks = async () => { ran = true; return {}; };
  const bad = await call('hack_tracker', { days: 7 });
  assert.deepEqual([bad.body.result.isError, bad.body.result.content[0].text], [true, 'Input refused: days must be 30, 90, 365 or 3650']);
  assert.equal(ran, false);

  markets.stablecoinList = async () => { throw Object.assign(new Error('DefiLlama stablecoins didn\'t answer'), { status: 503 }); };
  assert.equal((await call('stablecoins', {})).body.result.content[0].text, 'stablecoins couldn\'t run just now (DefiLlama stablecoins didn\'t answer). Try again shortly.');
  markets.tokens = markets.overview;
  markets.overview = async () => { throw new Error('ECONNRESET at some internal host'); };
  const hidden = (await call('markets_overview', {})).body.result.content[0].text;
  assert.equal(hidden, 'markets_overview couldn\'t run just now (a data source didn\'t answer). Try again shortly.', 'internal errors stay internal');
  assert.equal((await call('no_such_tool', {})).body.error.code, -32602);

  const paid = (await call('paid_services', {})).body.result.structuredContent;
  assert.deepEqual(paid.services.map(s => s.path), ['/v1/tokens/quick-check', '/v1/tokens/report', '/v1/approvals/cleanup', '/v1/presign/check', '/v1/governance/summary']);
  assert.equal(paid.services[0].url, 'https://rektbull.test/v1/tokens/quick-check');
  assert.equal(paid.services[0].price.price_usd, '$0.25');
  assert.match(paid.how_to_pay, /402[\s\S]*X-PAYMENT[\s\S]*only when the run succeeds/);
});

test('the daily allowance is the website\'s: shared per IP between the API and MCP', { skip: !DB && 'set TEST_DATABASE_URL' }, async () => {
  const approvals = require('../src/services/approvals');
  approvals.preview = async owner => ({ owner, open: 2, sources: ['Etherscan'] });
  const wallet = '0x' + 'ab'.repeat(20);
  const http = () => fetch(base + '/v1/approvals/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet }) });
  assert.equal((await http()).status, 200);
  assert.equal((await call('approvals_preview', { wallet: 'not a wallet' })).body.result.isError, true);
  assert.equal((await call('approvals_preview', { wallet })).body.result.structuredContent.open, 2, 'a refused input used no allowance');
  assert.equal((await http()).status, 200);
  const over = await call('approvals_preview', { wallet });
  assert.deepEqual([over.body.result.isError, over.body.result.content[0].text], [true, 'Daily limit reached: 3 a day per IP address without signing in (a RektBull bearer token from signing in with a wallet raises it). Try again tomorrow.']);
  assert.equal((await http()).status, 429, 'and the website sees the same count');
});

test('the reference: every documented endpoint is a real route; paid ones priced from the catalog', async () => {
  const routes = [require('../src/routes'), require('../src/routes/trading')].flatMap(r => r.stack).filter(l => l.route).flatMap(l => Object.keys(l.route.methods).map(m => `${m.toUpperCase()} ${l.route.path}`));
  for (const e of api.ENDPOINTS) assert.ok(routes.includes(`${e.method} ${e.path}`), `${e.method} ${e.path} is a route`);
  const { catalog } = { catalog: require('../src/payments/catalog') };
  for (const e of api.ENDPOINTS.filter(x => x.product)) assert.ok(catalog.PRODUCTS[e.product], e.product);
  assert.deepEqual(api.ENDPOINTS.filter(e => e.group === 'paid').map(e => e.product).sort(), ['approval_cleanup', 'governance_summary', 'presign_check', 'token_quick_check', 'token_report']);

  const ref = await (await fetch(base + '/v1/developers')).json();
  assert.equal(ref.mcp.url, 'https://rektbull.test/mcp');
  assert.equal(ref.endpoints.find(e => e.path === '/v1/tokens/report').price.x402_note, 'Above the $1 default limit of most x402 clients: raise your client\'s limit, or pay with credits.');
  assert.deepEqual(ref.endpoints.find(e => e.path === '/v1/checkup').free_per_day, { account: 10, anonymous: 3 });

  const doc = await (await fetch(base + '/v1/openapi.json')).json();
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.servers[0].url, 'https://rektbull.test');
  const qc = doc.paths['/v1/tokens/quick-check'].post;
  assert.deepEqual(qc.requestBody.content['application/json'].schema.required, ['chain', 'token_address']);
  assert.match(qc.responses[402].description, /\$0\.25 by x402/);
  assert.deepEqual(doc.paths['/v1/me'].get.security, [{ wallet: [] }]);
  assert.equal(doc.paths['/v1/discover/dapps'].get.parameters.find(p => p.name === 'sort').in, 'query');
});

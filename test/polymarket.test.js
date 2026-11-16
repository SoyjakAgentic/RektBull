/**
 * Polymarket: market data, order building and signing, wallet set-up, the
 * builder fee, proposals and session keys. Polymarket's APIs are stand-ins
 * fed fixtures cut from its real responses (test/fixtures/polymarket) and
 * from the shapes in docs.polymarket.com. Keys are made at run time.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

Object.assign(process.env, { JWT_SECRET: 'test-secret', ...(process.env.TEST_DATABASE_URL ? { DATABASE_URL: process.env.TEST_DATABASE_URL } : {}) });
const fx = name => JSON.parse(require('fs').readFileSync(path.join(__dirname, 'fixtures', 'polymarket', name), 'utf8'));

const pm = require('../src/providers/polymarket');
const cache = require('../src/lib/cache');
const usage = require('../src/providers/usage');
const markets = require('../src/polymarket/markets');

/** Stand-in for Polymarket's HTTP APIs: records each call, answers from `routes`. */
function standIn(routes) {
  const calls = [];
  const answer = async (method, url, body, opts) => {
    calls.push({ method, url, body, params: opts?.params, headers: opts?.headers });
    for (const [match, fn] of routes) if (url.includes(match)) return { data: await fn({ method, url, body, params: opts?.params || {}, headers: opts?.headers || {} }) };
    throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: { error: 'not found' } } });
  };
  pm.http.get = (url, opts) => answer('GET', url, undefined, opts);
  pm.http.post = (url, body, opts) => answer('POST', url, body, opts);
  cache._memory.clear();
  return calls;
}

test('polymarket: market data', async t => {
  const events = fx('events.json');
  const book = fx('book.json');

  await t.test('events come from Gamma, counted and cached, with prices, volume, liquidity and end dates', async () => {
    const calls = standIn([['/events', () => events]]);
    const before = [...usage._counts.entries()].filter(([k]) => k.startsWith('polymarket-gamma')).reduce((s, [, v]) => s + v, 0);
    const out = await markets.browse({});
    await markets.browse({});
    assert.equal(calls.length, 1, 'the second read came from the cache');
    assert.equal([...usage._counts.entries()].filter(([k]) => k.startsWith('polymarket-gamma')).reduce((s, [, v]) => s + v, 0), before + 1, 'counted once in provider usage');
    assert.deepEqual(calls[0].params, { active: true, closed: false, archived: false, limit: 20, offset: 0, order: 'volume24hr', ascending: false });
    assert.match(out.source, /Gamma API/);
    const e = out.events[0];
    assert.equal(e.slug, events[0].slug);
    assert.ok(e.volume_usd > 0 && e.liquidity_usd > 0 && e.end_date);
    const m = e.markets[0];
    assert.equal(m.outcomes.length, 2);
    assert.equal(m.position_system, 'ctf');
    assert.equal(m.outcomes[0].asset_id, JSON.parse(events[0].markets[0].clobTokenIds)[0], 'a CTF market trades its clobTokenIds');
    assert.ok(m.outcomes[0].price >= 0 && m.outcomes[0].price <= 1);
    assert.equal(m.accepting_orders, true);
  });

  await t.test('a V2 market trades its positionIds', () => {
    const m = markets.presentMarket({ ...events[0].markets[0], version: 'v2', positionIds: ['11', '12'] });
    assert.equal(m.position_system, 'v2');
    assert.deepEqual(m.outcomes.map(o => o.asset_id), ['11', '12']);
  });

  await t.test('resolution note: source, end date and UMA status, each from Polymarket or marked as not given', () => {
    const base = { ...events[0].markets[0], endDate: new Date(Date.now() + 86400000).toISOString() };
    const quiet = markets.resolutionNote({ ...base, resolutionSource: 'https://example.org/results', umaResolutionStatus: undefined, umaResolutionStatuses: '[]' });
    assert.equal(quiet.resolution_source, 'https://example.org/results');
    assert.equal(quiet.disputed, false);
    assert.deepEqual(quiet.flags, []);
    assert.match(quiet.uma_status_note, /no resolution request yet/);
    const none = markets.resolutionNote({ ...base, resolutionSource: '' });
    assert.equal(none.resolution_source, null);
    assert.match(none.resolution_source_note, /not given by Polymarket/);
    assert.ok(none.flags.some(f => /no resolution source/.test(f)));
    const disputed = markets.resolutionNote({ ...base, umaResolutionStatus: 'proposed', umaResolutionStatuses: '["proposed","disputed","proposed"]' });
    assert.equal(disputed.disputed, true);
    assert.ok(disputed.flags.some(f => /disputed/.test(f)));
    const proposed = markets.resolutionNote({ ...base, umaResolutionStatus: 'proposed', umaResolutionStatuses: '["proposed"]' });
    assert.ok(proposed.flags.some(f => /challenge period/.test(f)));
    // The Data API's row wins over Gamma's history when it was read.
    assert.equal(markets.resolutionNote(base, { status: 'disputed', was_disputed: true }).disputed, true);
    assert.match(markets.resolutionNote(base, { status: 'resolved', was_disputed: false }).source, /resolutions/);
    const late = markets.resolutionNote({ ...base, endDate: '2020-01-01T00:00:00Z', closed: false });
    assert.ok(late.flags.some(f => /end date has passed/.test(f)));
  });

  await t.test('one market reads its dispute state from the Data API, and says so when that fails', async () => {
    standIn([['/markets', () => [events[0].markets[0]]], ['/v2/resolutions', () => ({ data: [{ condition_id: events[0].markets[0].conditionId, status: 'challenged', was_disputed: true }] })]]);
    const ok = await markets.marketBySlug(events[0].markets[0].slug);
    assert.equal(ok.market.resolution.disputed, true);
    assert.equal(ok.market.resolution.uma_status, 'challenged');
    standIn([['/markets', () => [events[0].markets[0]]]]);
    const partial = await markets.marketBySlug(events[0].markets[0].slug);
    assert.match(partial.market.resolution.not_checked, /Data API v2.*couldn't be read/);
  });

  await t.test('the book: best prices first, with the tick size and minimum size orders must meet', async () => {
    standIn([['/book', () => book]]);
    const b = markets.presentBook(await pm.book(book.asset_id));
    assert.equal(b.tick_size, book.tick_size);
    assert.equal(b.min_order_size, book.min_order_size);
    assert.ok(b.best_bid < b.best_ask);
    assert.equal(b.best_bid, Math.max(...book.bids.map(x => Number(x.price))));
    assert.equal(b.best_ask, Math.min(...book.asks.map(x => Number(x.price))));
    assert.match(b.source, /CLOB API/);
  });

  await t.test('positions and PnL are Polymarket\'s own figures', async () => {
    standIn([['/v2/positions', () => fx('positions.json')]]);
    const out = await markets.positionsFor('0x' + '00'.repeat(19) + '01');
    assert.equal(out.positions.length, 2);
    assert.equal(out.complete, true);
    assert.equal(out.totals.redeemable, 2);
    assert.match(out.source, /Data API v2/);
    assert.match(out.pnl_note, /Polymarket's own figure/);
  });

  await t.test('a failed read says which API failed and why, over HTTP too', async () => {
    standIn([]);
    await assert.rejects(markets.browse({}), err => err.isPolymarketUnavailable && /Gamma API.*couldn't be read: not found \(HTTP 404\)/.test(err.message));
    const server = require('../src/app').createApp().listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/polymarket/events`);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error, 'source_unavailable');
      assert.match(body.source, /Gamma/);
      assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/v1/polymarket/positions?wallet=nope`)).status, 400);
    } finally { server.close(); }
  });
});

/**
 * AI forecasts and proposals (forecasts/): the screen, research that keeps only
 * sources the web search returned, proposals charged to Safety Pro AI credits
 * only for users who asked, the switches, and scoring once a market resolves.
 * The model and Polymarket are stand-ins: nothing is spent. Needs TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { JWT_SECRET: 'test-secret', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: DB || '' });

test('reading the model\'s JSON', () => {
  const { lastJson } = require('../src/forecasts/polymarket');
  assert.deepEqual(lastJson('Thinking...\n```json\n{"prob": 0.7}\n```'), { prob: 0.7 });
  assert.deepEqual(lastJson('[{"slug":"a","prob":0.2}]'), [{ slug: 'a', prob: 0.2 }]);
  assert.equal(lastJson('no json here'), null);
});

test('the proposal a forecast makes: the side it favours, only past the edge, only at medium or high confidence', () => {
  const { proposalFor } = require('../src/forecasts/polymarket');
  const m = { outcome: 'Yes', asset_id: '1', other: { name: 'No', asset_id: '2' } };
  const s = { edge_pct: 8 };
  assert.deepEqual(proposalFor({ ai_prob: 0.7, market_prob: 0.5, confidence: 'high' }, m, s), { side: 'Yes', assetId: '1', priceLimit: 0.62 });
  assert.deepEqual(proposalFor({ ai_prob: 0.3, market_prob: 0.5, confidence: 'medium' }, m, s), { side: 'No', assetId: '2', priceLimit: 0.62 });
  assert.equal(proposalFor({ ai_prob: 0.55, market_prob: 0.5, confidence: 'high' }, m, s), null, 'under the edge');
  assert.equal(proposalFor({ ai_prob: 0.9, market_prob: 0.5, confidence: 'low' }, m, s), null, 'low confidence');
});

test('screen, research, propose, resolve', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  const settings = require('../src/admin/settings');
  settings.reset();
  const forecasts = require('../src/forecasts/polymarket');
  const proposals = require('../src/forecasts/proposals');

  // Stand-in Polymarket: two open binary markets, then one resolves.
  const markets = require('../src/polymarket/markets');
  const mk = (slug, price) => ({ slug, question: `Will ${slug} happen?`, accepting_orders: true, end_date: new Date(Date.now() + 30 * 86400000).toISOString(), volume_24h_usd: 1e6,
    outcomes: [{ name: 'Yes', price, asset_id: `${slug}-yes` }, { name: 'No', price: 1 - price, asset_id: `${slug}-no` }] });
  markets.browse = async ({ offset }) => ({ events: offset ? [] : [{ title: 'Event', markets: [mk('alpha', 0.5), mk('beta', 0.4)] }] });
  let closed = false;
  markets.marketBySlug = async slug => ({ market: { ...mk(slug, 0.5), description: 'Resolves Yes if it happens.', closed, outcomes: closed ? [{ name: 'Yes', price: 1 }, { name: 'No', price: 0 }] : mk(slug, 0.5).outcomes } });

  // Stand-in model: the screen flags alpha; research cites one real search result and one it made up.
  const claude = require('../src/ai/claude');
  const asked = [];
  let researchSources = ['https://news.example/alpha', 'https://made-up.example/x'];
  claude.analyze = async args => {
    asked.push(args);
    if (args.webSearches) return { text: `Done.\n\`\`\`json\n${JSON.stringify({ prob: 0.75, confidence: 'high', reasoning: 'Recent reporting points to yes.', resolution_notes: 'Official announcement.', sources: researchSources })}\n\`\`\``, model: 'claude-sonnet-5-5', usd: 0.12, urls: ['https://news.example/alpha'] };
    return { text: JSON.stringify([{ slug: 'alpha', prob: 0.72, research: true, why: 'priced too low' }, { slug: 'beta', prob: 0.41, research: false, why: 'fair' }]), model: 'claude-haiku-5-5', usd: 0.004, urls: [] };
  };

  assert.deepEqual(await forecasts.tick(), { off: true }, 'off until switched on');
  const turnOn = v => settings.set('forecasts', v, { wallet: '0xadmin', action: 'forecasts', reason: 'test' });

  // A user with Safety Pro who asked for Polymarket proposals, and one who didn't.
  const { rows: [a] } = await db.query(`INSERT INTO accounts (wallet) VALUES ('0x${'a1'.repeat(20)}') RETURNING id`);
  const { rows: [b] } = await db.query(`INSERT INTO accounts (wallet) VALUES ('0x${'b2'.repeat(20)}') RETURNING id`);
  for (const id of [a.id, b.id]) await db.query(`INSERT INTO passes (account_id, product, starts_at, ends_at) VALUES ($1, 'pro_30d', now(), now() + interval '30 days')`, [id]);
  await proposals.saveSettings(a.id, { polymarket: true, max_per_day: 3 });

  await t.test('forecasts on, proposals off: forecasts are made and logged, nobody is offered anything', async () => {
    await turnOn({ polymarket: true, polymarket_proposals: false });
    const out = await forecasts.tick({ force: true });
    assert.deepEqual([out.screened, out.researched, out.offered], [2, 1, 0]);
    assert.equal(asked[0].model, 'claude-haiku-5-5'); assert.equal(asked[0].webSearches || 0, 0, 'the screen never searches');
    assert.equal(asked[1].model, 'claude-sonnet-5-5'); assert.equal(asked[1].webSearches, 3);
    const { rows: [r] } = await db.query(`SELECT * FROM ai_forecasts WHERE stage = 'research'`);
    assert.deepEqual(r.sources, ['https://news.example/alpha'], 'only what the search returned; the made-up source is dropped');
    assert.match(r.reasoning, /How it resolves: Official announcement/);
  });

  await t.test('proposals on: offered free to the user who asked; acting on one is charged to their AI credits, once', async () => {
    await turnOn({ polymarket: true, polymarket_proposals: true });
    await db.query(`DELETE FROM ai_forecasts WHERE stage = 'research'`); // research alpha again today
    const out = await forecasts.tick({ force: true });
    assert.equal(out.offered, 1);
    const list = await proposals.list(a.id);
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].side, list[0].asset_id, list[0].price_limit, list[0].price_usd, list[0].paid_from], ['Yes', 'alpha-yes', 0.67, 0.25, null]);
    assert.equal(list[0].forecast.ai_prob, 0.75);
    assert.equal((await proposals.list(b.id)).length, 0, 'not offered to a user who didn\'t ask');
    const allowance = require('../src/payments/aiAllowance');
    assert.equal((await allowance.status(a.id)).used_usd, 0, 'offering it costs nothing');
    const approved = await proposals.act(a.id, list[0].id, 'approved');
    assert.equal(approved.status, 'approved');
    assert.equal(approved.paid_from, 'allowance');
    assert.equal((await allowance.status(a.id)).used_usd, 0.25, 'acting on it: $0.25 from the 30-day allowance');
    await assert.rejects(proposals.act(a.id, list[0].id, 'dismissed'), /Only an offered proposal/);
    await assert.rejects(proposals.act(a.id, list[0].id, 'approved'), /Only an offered proposal/, 'never charged twice');
    assert.equal((await allowance.status(a.id)).used_usd, 0.25);
    // An order from it: the account's own approved proposal, for its outcome, a buy.
    assert.equal((await proposals.forOrder(a.id, list[0].id, { asset_id: 'alpha-yes', side: 'BUY' })).id, list[0].id);
    await assert.rejects(proposals.forOrder(a.id, list[0].id, { asset_id: 'alpha-no', side: 'BUY' }), /isn't the outcome/);
    await assert.rejects(proposals.forOrder(a.id, list[0].id, { asset_id: 'alpha-yes', side: 'SELL' }), /is a buy/);
    await assert.rejects(proposals.forOrder(b.id, list[0].id, { asset_id: 'alpha-yes', side: 'BUY' }), /No such proposal/);
  });

  await t.test('a researched forecast with no real source is dropped, never stored as a guess', async () => {
    researchSources = ['https://made-up.example/only'];
    await db.query(`UPDATE ai_forecasts SET created_at = now() - interval '25 hours' WHERE stage = 'research'`); // research alpha again
    const { rows: [{ n: before }] } = await db.query(`SELECT COUNT(*)::int AS n FROM ai_forecasts WHERE stage = 'research'`);
    const out = await forecasts.tick({ force: true });
    assert.equal(out.researched, 0);
    const { rows: [{ n: after }] } = await db.query(`SELECT COUNT(*)::int AS n FROM ai_forecasts WHERE stage = 'research'`);
    assert.equal(after, before, 'nothing stored');
    researchSources = ['https://news.example/alpha'];
  });

  await t.test('once the market resolves, each forecast is scored against the market\'s own price', async () => {
    await db.query(`UPDATE ai_forecasts SET created_at = now() - interval '2 hours'`);
    closed = true;
    await forecasts.resolve();
    const tr = await forecasts.trackRecord();
    const research = tr.stages.find(s => s.stage === 'research');
    assert.equal(research.resolved, 1);
    assert.equal(research.brier_ai, 0.0625, '(0.75 − 1)²');
    assert.equal(research.brier_market, 0.25, '(0.5 − 1)²');
    assert.equal(research.ai_beat_market, 1);
    assert.equal(tr.recent[0].happened, true);
  });
});

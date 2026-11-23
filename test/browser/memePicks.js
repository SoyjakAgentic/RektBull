/**
 * The Launches page's AI picks card in a real Chromium: the public scorecard,
 * the rules, opting in, a pick with its reason, facts and checks, and acting on
 * it: free, then the Trade desk on that coin. The session
 * is a signed-in token; the data is seeded. Needs a database:
 *
 *   TEST_DATABASE_URL=postgres://… node test/browser/memePicks.js [screenshot.png]
 *
 * Not part of `npm test` (it needs a browser). Exits non-zero on failure.
 */
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error('set TEST_DATABASE_URL'); process.exit(1); }
Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '' });

(async () => {
  const db = require('../../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../../src/config/migrate').migrate();
  const settings = require('../../src/admin/settings');
  await settings.set('forecasts', { memes: true, meme_proposals: true }, { wallet: '0xadmin', action: 'forecasts', reason: 'test' });
  // The page's other cards read live feeds: stand-ins, so only the picks card is under test.
  const launches = require('../../src/services/launches');
  launches.feed = async ({ chain }) => ({ chain, chain_name: chain, tokens: [], sources: ['stand-in'], note: '' });
  launches.curves = async ({ chain }) => ({ chain, launchpad: 'x', tokens: [], source: 'stand-in', note: '' });
  require('../../src/services/liveLaunches').live = async ({ chain }) => ({ chain, chain_name: chain, read_at: new Date().toISOString(), refresh_seconds: 10, columns: { new: { items: [], source: 's' }, graduating: { items: [], source: 's' }, graduated: { items: [], source: 's', hours_covered: 1 } }, note: '' });

  const token = '0x' + 'a1'.repeat(20);
  const { rows: [acct] } = await db.query(`INSERT INTO accounts (wallet) VALUES ('0x${'e5'.repeat(20)}') RETURNING *`);
  const facts = { price_usd: 0.0012, liquidity_usd: 120000, volume_24h_usd: 900000, buys_24h: 900, sells_24h: 500, change_1h_pct: 8, change_24h_pct: 40, age_hours: 30, buy_ratio: 1.8, source: 'DexScreener (24-hour figures, all its pairs)' };
  const checks = [{ check: 'goplus', flags: [], source: 'GoPlus token security' }, { check: 'bundle', verdict: 'no_bundle_found', source: 'Base RPC' }];
  const { rows: [sig] } = await db.query(`INSERT INTO meme_signals (run_id, chain, token, symbol, picked, score, price_usd, facts, checks, reason, risks, model)
    VALUES (gen_random_uuid(), 'base', $1, 'AAA', true, 9, 0.0012, $2, $3, '900 buys to 500 sells in 24 hours. Most meme coins lose most of their value.', '["Most meme coins lose most of their value"]', 'claude-haiku-5-5') RETURNING *`,
  [token, JSON.stringify(facts), JSON.stringify(checks)]);
  // One older pick, scored, for the public scorecard.
  await db.query(`INSERT INTO meme_signals (run_id, chain, token, symbol, picked, score, price_usd, facts, price_1h, price_24h, scored_1h_at, scored_24h_at, created_at)
    VALUES (gen_random_uuid(), 'solana', 'OldMint11111111111111111111111111111111111', 'OLD', true, 5, 1, '{}', 1.1, 2, now(), now(), now() - interval '2 days')`);
  const proposals = require('../../src/forecasts/proposals');
  await proposals.offerSignal(acct.id, { signal: sig, priceUsd: 0 }); // free: no pass, no credits needed
  // A pick made 7 hours ago, never acted on: expired.
  const { rows: [old] } = await db.query(`INSERT INTO meme_signals (run_id, chain, token, symbol, picked, score, price_usd, facts, checks, reason, risks, model, created_at)
    VALUES (gen_random_uuid(), 'base', $1, 'STALE', true, 8, 0.5, $2, '[]', 'An older pick.', '[]', 'claude-haiku-5-5', now() - interval '7 hours') RETURNING *`, ['0x' + 'b2'.repeat(20), JSON.stringify(facts)]);
  await proposals.offerSignal(acct.id, { signal: old, priceUsd: 0 });
  // DexScreener's price now: AAA picked at $0.0012, now $0.00156.
  require('../../src/providers/dexscreener').prices = async (chain, tokens) => Object.fromEntries(tokens.filter(t => t === token).map(t => [t, 0.00156]));
  const jwt = require('../../src/auth/siwe').issueToken(acct);

  const server = require('../../src/app').createApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.addInitScript(([t, w]) => { sessionStorage.setItem('rb_token', t); sessionStorage.setItem('rb_wallet', w); sessionStorage.setItem('rb_kind', 'evm'); }, [jwt, acct.wallet]);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  try {
    await page.goto(url + '/launches');
    await page.locator('#p-score', { hasText: 'Picks scored at 24 hours' }).waitFor();
    assert.match(await page.textContent('#p-score'), /\+100%/, 'the old pick doubled in 24 hours');
    assert.match(await page.textContent('#p-recent'), /OLD/);
    console.log('✔ the public scorecard');

    await page.locator('#p-list', { hasText: '900 buys to 500 sells' }).waitFor();
    const card = await page.textContent('#p-list');
    assert.match(card, /AAA on Base/);
    assert.match(card, /Liquidity \$120\.0K, \$900\.0K traded in 24 hours, 900 buys to 500 sells, \+8% in the last hour \(DexScreener/);
    assert.match(card, /GoPlus flags \(GoPlus token security\); bundle and insider check \(Base RPC\)/);
    assert.match(card, /Now \$0\.00156 \(\+30% since the pick\) · DexScreener, read .*Picks expire after 6 hours/);
    assert.match(card, /STALE on Base · expired.*Expired: picked over 6 hours ago, so the facts behind it are stale/);
    assert.ok(card.indexOf('AAA on Base') < card.indexOf('STALE on Base'), 'live picks first');
    assert.doesNotMatch(card, /An older pick/, 'an expired pick is one line, without its reason');
    assert.equal(await page.getByRole('button', { name: 'Review the trade', exact: true }).count(), 1, 'no button on the expired pick');
    console.log('✔ the price now against the price when picked; an expired pick has no trade button');
    assert.match(await page.textContent('#p-about'), /not a recommendation, and no coin is called safe/);
    await page.click('#picks-card summary');
    assert.match(await page.textContent('#p-rules'), /At least \$50\.0K of liquidity/);
    console.log('✔ a pick with its reason, facts, checks and the rules');
    if (process.argv[2]) await page.locator('#picks-card').screenshot({ path: process.argv[2] });

    await page.check('#p-on');
    await page.locator('#p-msg', { hasText: 'Saved.' }).waitFor();
    assert.equal((await proposals.getSettings(acct.id)).meme, true);
    assert.match(await page.textContent('#picks-card h2'), /Free/);
    assert.match(await page.textContent('#p-about'), /Picks are free; the trade itself has RektBull's usual 1% fee/);
    await page.getByRole('button', { name: 'Review the trade', exact: true }).click();
    await page.waitForURL(/\/trade\?chain=base&token=0x(a1){20}&side=buy#trade-card/);
    const { rows: [p] } = await db.query(`SELECT status, paid_from FROM ai_proposals WHERE venue = 'meme' AND market = 'AAA'`);
    assert.deepEqual([p.status, p.paid_from], ['approved', null], 'free: nothing charged');
    console.log('✔ acting on a pick: free, then the Trade desk on that coin');

    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(url + '/launches#picks-card');
    await page.locator('#p-list', { hasText: 'Open the trade' }).waitFor();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(wide, false, 'no sideways scroll at phone width');
    console.log('✔ phone width');
    assert.deepEqual(errors, []);
    console.log('ok: AI picks on the Launches page');
  } finally {
    await browser.close();
    server.close();
    await db.getPool().end();
  }
})().catch(err => { console.error(err); process.exit(1); });

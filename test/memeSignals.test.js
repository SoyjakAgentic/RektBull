/**
 * Meme coin proposals (memes/signals.js): the rules, the safety checks (a failed
 * check or one that couldn't run drops a coin), the AI's explanation held to the
 * facts, picks free for every user who asks (a price, when the admin sets one, charged once), and the
 * scorecard at 1 hour and 24 hours. Every source and the model are stand-ins:
 * nothing is spent. The database parts need TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const DB = process.env.TEST_DATABASE_URL;
Object.assign(process.env, { JWT_SECRET: 'test-secret', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: DB || '' });

const signals = require('../src/memes/signals');
signals.PACE.ms = 0; // no pacing against stand-ins
const S = { meme_min_liquidity_usd: 50000, meme_min_volume_usd: 100000, meme_min_buys: 200, meme_picks: 3, meme_proposal_usd: 0.25 };
const NOW = Date.parse('2026-11-22T12:00:00Z');
const pool = (over = {}) => ({
  pair: '0xpool', symbol: 'BULL', name: 'Bull', price_usd: 0.0012,
  liquidity_usd: 120000, volume_24h_usd: 600000, market_cap_usd: 900000, change_1h_pct: 8, change_24h_pct: 40,
  buys_24h: 900, sells_24h: 500, created_at: new Date(NOW - 30 * 3600000).toISOString(), ...over,
});

test('the rules: what passes, and why the rest don\'t', () => {
  const ok = signals.screen(pool(), S, NOW);
  assert.equal(ok.pass, true);
  assert.equal(ok.facts.buy_ratio, 1.8);
  assert.ok(ok.score > 0);
  const why = over => signals.screen(pool(over), S, NOW).why;
  assert.match(why({ created_at: new Date(NOW - 20 * 60000).toISOString() }), /under 1 hour old/);
  assert.match(why({ created_at: new Date(NOW - 20 * 86400000).toISOString() }), /over 14 days old/);
  assert.match(why({ liquidity_usd: 20000 }), /liquidity under/);
  assert.match(why({ volume_24h_usd: 50000 }), /volume under/);
  assert.match(why({ buys_24h: 150, sells_24h: 100 }), /under 200 buys/);
  assert.match(why({ buys_24h: 400, sells_24h: 500 }), /not more buys than sells/);
  assert.match(why({ buys_24h: 3000, sells_24h: 500 }), /one-way buying/);
  assert.match(why({ change_1h_pct: 80 }), /last hour/);
  assert.match(why({ change_1h_pct: -25 }), /last hour/);
  assert.match(why({ change_24h_pct: 500 }), /up too far/);
  // The warning signs its trading shows (discover.poolSignals): down 60% or more in 24 hours.
  assert.match(why({ change_24h_pct: -70 }), /Down 70%/);
  // A higher score: more turnover and more buying pressure.
  assert.ok(signals.screen(pool({ volume_24h_usd: 1200000 }), S, NOW).score > ok.score);
});

test('the AI\'s reason may name only the facts\' numbers', () => {
  const facts = { liquidity_usd: 120000, volume_24h_usd: 600000, buys_24h: 900, sells_24h: 500, change_1h_pct: 8 };
  assert.equal(signals.onlyFactNumbers('900 buys to 500 sells, $600,000 traded against $120,000 of liquidity, up 8% in the last hour.', facts), true);
  assert.equal(signals.onlyFactNumbers('About $600K traded, $0.12M of liquidity... in 24 hours.', facts), true, 'thousands and millions, and the rules\' periods');
  assert.equal(signals.onlyFactNumbers('Could go up 10x, with 5,000 holders.', facts), false, 'an invented number');
  assert.match(signals.plainReason(facts), /\$600,000 traded in 24 hours against \$120,000 of liquidity, 900 buys to 500 sells, 8% in the last hour/);
});

test('a run, proposals, acting on one, and the scorecard', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());
  const settings = require('../src/admin/settings');
  settings.reset();
  const proposals = require('../src/forecasts/proposals');

  // Stand-ins. Seen: A and B in Base's trending pools, C and the dead D in its newest pools, a Solana coin just
  // graduated (the live feed); an old coin in BNB Chain's trending pools. DexScreener's figures: A, B and C pass
  // the rules, D is dead, the old coin is too old. GoPlus flags C; the bundle check can't run on B; the model
  // invents a number once.
  const A = '0x' + 'a1'.repeat(20); const B = '0x' + 'b2'.repeat(20); const C = '0x' + 'c3'.repeat(20); const D = '0x' + 'd4'.repeat(20);
  const OLD = '0x' + 'f6'.repeat(20); const SOL = 'So1anaMint1111111111111111111111111111111111';
  const now = Date.now();
  const at = h => new Date(now - h * 3600000).toISOString();
  const seen = (address, symbol) => ({ pool: '0xp', token: { address, symbol } });
  const gt = require('../src/providers/geckoterminal');
  gt.pools = async (kind, chain) => ({ base: [seen(A.toUpperCase().replace('0X', '0x'), 'AAA'), seen(B, 'BBB')], bsc: [seen(OLD, 'OLD')], solana: [] }[chain]);
  gt.newPoolsPage = async (chain, page) => (chain === 'base' && page === 1 ? [seen(C, 'CCC'), seen(D, 'DDD'), seen('not-an-address')] : []);
  require('../src/services/liveLaunches').live = async ({ chain }) => {
    if (chain === 'bsc') throw new Error('logs refused');
    return { columns: { graduated: { items: chain === 'solana' ? [{ token: SOL, symbol: 'SOLY' }] : [] } } };
  };
  const dex = require('../src/providers/dexscreener');
  const stats = {
    [A]: pool({ symbol: 'AAA', created_at: at(30), volume_24h_usd: 900000 }), [B]: pool({ symbol: 'BBB', created_at: at(30) }),
    [C]: pool({ symbol: 'CCC', created_at: at(30), volume_24h_usd: 700000 }), [D]: pool({ symbol: 'DDD', created_at: at(10), volume_24h_usd: 2000 }),
    [OLD]: pool({ symbol: 'OLD', created_at: at(24 * 400) }), [SOL]: pool({ symbol: 'SOLY', created_at: at(200), volume_24h_usd: 650000 }),
  };
  dex.pairs = async (chain, tokens) => Object.fromEntries(tokens.filter(x => stats[x]).map(x => [x, stats[x]]));
  const discover = require('../src/services/discover');
  discover.flags = async ({ token }) => (token === C
    ? { flags: [{ level: 'bad', text: 'Flagged as a honeypot: buyers may not be able to sell', source: 'GoPlus' }], facts: {}, source: 'GoPlus token security (cached for 6 hours)' }
    : { flags: [{ level: 'ok', text: 'None of GoPlus\'s red flags', source: 'GoPlus' }], facts: { buy_tax_pct: 0, sell_tax_pct: 0 }, source: 'GoPlus token security (cached for 6 hours)' });
  require('../src/services/launchSafety').check = async ({ token }) => {
    if (token === B) throw new Error('Etherscan\'s free plan is busy');
    return { verdict: 'no_bundle_found', summary: 'No launch bundle found', sources: ['Base RPC (the launch block)'] };
  };
  require('../src/services/solanaLaunches').mintFlags = async ts => Object.fromEntries(ts.map(x => [x, { flags: [{ level: 'ok', text: 'No mint or freeze authority left', source: 'Solana RPC (the mint)' }], source: 'Solana RPC (the mint)' }]));
  const claude = require('../src/ai/claude');
  let n = 0;
  claude.available = () => true;
  claude.analyze = async args => {
    n++;
    assert.equal(args.model, 'claude-haiku-5-5'); assert.equal(args.webSearches || 0, 0, 'no web search: the facts only');
    const facts = JSON.parse(args.prompt);
    const reason = n === 1 ? `${facts.buys_24h} buys to ${facts.sells_24h} sells in 24 hours. Most meme coins lose most of their value.` : 'Could do 10x from here.';
    return { text: JSON.stringify({ reason, risks: ['Most meme coins lose most of their value'] }), model: 'claude-haiku-5-5', usd: 0.001, urls: [] };
  };

  const { rows: [acct] } = await db.query(`INSERT INTO accounts (wallet) VALUES ('0x${'e5'.repeat(20)}') RETURNING *`);
  await db.query(`INSERT INTO passes (account_id, product, starts_at, ends_at) VALUES ($1, 'pro_30d', now(), now() + interval '30 days')`, [acct.id]);
  await proposals.saveSettings(acct.id, { meme: true });
  // A user with no pass and no AI credits: picks are free, so they get them too.
  const { rows: [free] } = await db.query(`INSERT INTO accounts (wallet) VALUES ('0x${'f7'.repeat(20)}') RETURNING *`);
  await proposals.saveSettings(free.id, { meme: true });
  const turnOn = v => settings.set('forecasts', v, { wallet: '0xadmin', action: 'forecasts', reason: 'test' });

  await t.test('off until switched on', async () => {
    assert.equal((await signals.tick()).off, true);
  });

  let out;
  await t.test('picks: only coins that passed every check; a failed check or one that couldn\'t run drops a coin', async () => {
    await turnOn({ memes: true, meme_proposals: true });
    out = await signals.tick({ force: true });
    assert.equal(out.ran, true);
    assert.equal(out.added, 6, 'A, B, C, D, the old coin and the graduated Solana coin; not the bad address; BNB Chain\'s live feed was skipped');
    assert.equal(out.passed, 4, 'the old coin and the dead one didn\'t pass the rules');
    const { rows: wl } = await db.query('SELECT token, source, dropped_at FROM meme_watchlist ORDER BY token');
    assert.ok(wl.find(r => r.token === D).dropped_at, 'dead after 6 hours: it leaves the watchlist');
    assert.equal(wl.find(r => r.token === A).source, 'GeckoTerminal trending pools');
    assert.equal(wl.find(r => r.token === SOL).source, 'just graduated (the live feed)');
    const { rows } = await db.query('SELECT token, picked, reason, model, checks FROM meme_signals ORDER BY score DESC');
    const picked = rows.filter(r => r.picked).map(r => r.token).sort();
    assert.deepEqual(picked, [A, SOL].sort(), 'C failed GoPlus, B\'s bundle check couldn\'t run');
    assert.equal(rows.length, 4, 'every coin that passed is kept, for the comparison');
    assert.deepEqual(out.dropped.map(d => d.token).sort(), [B, C].sort());
    assert.match(out.dropped.find(d => d.token === B).why, /couldn't run/);
    const a = rows.find(r => r.token === A);
    assert.match(a.reason, /^900 buys to 500 sells/);
    assert.deepEqual(a.checks.map(c => c.check), ['goplus', 'bundle']);
    const s = rows.find(r => r.token === SOL);
    assert.match(s.reason, /It passed RektBull's rules/, 'the reason with an invented number was replaced by the plain one');
    assert.deepEqual(s.checks.map(c => c.check), ['mint'], 'Solana: the mint; over a week old, no bundle check');
  });

  await t.test('free: offered to every user who asked, pass or not; acting opens the Trade desk and charges nothing', async () => {
    assert.equal(out.offered, 4, 'two picks, two users');
    const list = (await proposals.list(free.id)).filter(p => p.venue === 'meme');
    assert.equal(list.length, 2);
    const p = list.find(x => x.signal.token === A);
    assert.equal(p.price_usd, 0);
    assert.equal(p.signal.trade, `/trade?chain=base&token=${A}&side=buy#trade-card`);
    assert.equal(p.signal.facts.buys_24h, 900);
    const done = await proposals.act(free.id, p.id, 'approved');
    assert.equal(done.status, 'approved');
    assert.equal(done.paid_from, null, 'nothing charged');
    await assert.rejects(proposals.act(free.id, p.id, 'approved'), /Only an offered proposal/);
  });

  await t.test('with a price set by the admin: only accounts with AI credits get picks, charged once when they act', async () => {
    const { rows: [sig] } = await db.query('SELECT * FROM meme_signals WHERE token = $1', [B]);
    assert.equal(await proposals.offerSignal(free.id, { signal: sig, priceUsd: 0.25 }), null, 'no credits: not offered');
    const p = await proposals.offerSignal(acct.id, { signal: sig, priceUsd: 0.25 });
    assert.ok(p);
    const allowance = require('../src/payments/aiAllowance');
    assert.equal((await allowance.status(acct.id)).used_usd, 0, 'offering costs nothing');
    const done = await proposals.act(acct.id, p.id, 'approved');
    assert.equal(done.paid_from, 'allowance');
    assert.equal((await allowance.status(acct.id)).used_usd, 0.25);
    await assert.rejects(proposals.act(acct.id, p.id, 'approved'), /Only an offered proposal/, 'never charged twice');
  });

  await t.test('a coin isn\'t picked or counted again within a day', async () => {
    const again = await signals.tick({ force: true });
    assert.equal(again.picked, 0);
    const { rows: [{ n: count }] } = await db.query('SELECT COUNT(*)::int AS n FROM meme_signals');
    assert.equal(count, 4);
  });

  await t.test('the scorecard: priced again at 1 hour and 24 hours, picks against all the rest', async () => {
    await db.query(`UPDATE meme_signals SET created_at = now() - interval '25 hours'`);
    const dex = require('../src/providers/dexscreener');
    const asked = [];
    dex.prices = async (chain, tokens) => { asked.push([chain, tokens.length]); return { [A]: 0.0024, [B]: 0.0006, [SOL]: 0.0012 }; }; // C has no pair left
    // Both windows are due: 1 hour (25 h ago is past its 6-hour window, so it's closed unpriced) and 24 hours.
    await signals.score();
    const { rows } = await db.query('SELECT token, price_1h, price_24h, scored_1h_at, scored_24h_at FROM meme_signals');
    for (const r of rows) { assert.ok(r.scored_1h_at && r.scored_24h_at); assert.equal(r.price_1h, null, 'the 1-hour window was missed, not guessed'); }
    assert.equal(Number(rows.find(r => r.token === A).price_24h), 0.0024);
    assert.equal(Number(rows.find(r => r.token === C).price_24h), 0, 'no pair left counts as 0');
    const tr = await signals.trackRecord();
    assert.equal(tr.picks.scored_24h, 2);
    assert.equal(tr.picks.median_24h_pct, 50, 'A doubled, SOL flat: median +50%');
    assert.equal(tr.all_passed.scored_24h, 2);
    assert.equal(tr.all_passed.halved_24h_pct, 100, 'B fell 50%, C went to 0');
    assert.equal(tr.recent.length, 2);
    assert.deepEqual(asked.map(a => a[0]).sort(), ['base', 'solana']);
  });

  await t.test('the public scorecard and the proposals list over HTTP', async () => {
    const server = require('../src/app').createApp().listen(0);
    t.after(() => server.close());
    const r = await fetch(`http://127.0.0.1:${server.address().port}/v1/memes/track-record`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.picks.scored_24h, 2);
    assert.ok(body.rules.min_age_hours >= 1);
  });
});

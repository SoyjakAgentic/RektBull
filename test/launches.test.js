/**
 * The Launches desk and the Meme Watch agent, with the data providers as
 * stand-ins: the feed (newest first, GoPlus for the newest few), a token's
 * card, the bundle check a buy of a young token adds (block, confirm, or a
 * check that couldn't run), and Meme Watch's alerts (liquidity pulled, a new
 * GoPlus flag, the stop-loss, insiders selling), each with a ready-made sell.
 * The agent part runs only when TEST_DATABASE_URL is set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const T = n => '0x' + String(n).repeat(40).slice(0, 40);
const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString();

test('the feed: newest first, warning signs, GoPlus for the newest few', async () => {
  const discover = require('../src/services/discover');
  const launches = require('../src/services/launches');
  const realTokens = discover.tokens, realFlags = discover.flags;
  const flagged = [];
  discover.tokens = async ({ list, chain }) => ({
    list, chain, source: 'GeckoTerminal newest pools on Base (refreshed every 5 minutes)',
    tokens: Array.from({ length: 10 }, (_, i) => ({
      token: { address: T(i + 1).toUpperCase().replace('0X', '0x'), symbol: `T${i}`, name: `Token ${i}` }, pool: T(9), dex: i % 2 ? 'uniswap-v4-base' : 'aerodrome-base', quote: 'WETH',
      created_at: hoursAgo(10 - i), liquidity_usd: 1000 * i, signals: [{ level: 'warn', text: 'Pool opened recently', source: 'GeckoTerminal' }],
    })),
  });
  discover.flags = async ({ token }) => { flagged.push(token); return { flags: [{ level: 'bad', text: 'Flagged as a honeypot', source: 'GoPlus' }] }; };
  try {
    const f = await launches.feed({ chain: 'base' });
    assert.deepEqual(f.tokens.map(t => t.symbol), ['T9', 'T8', 'T7', 'T6', 'T5', 'T4', 'T3', 'T2', 'T1', 'T0'], 'newest first');
    assert.equal(f.tokens[0].token, T(10).toLowerCase(), 'addresses lowercased');
    assert.deepEqual(f.tokens.slice(0, 2).map(t => t.exchange), ['Uniswap v4', 'Aerodrome']);
    assert.equal(flagged.length, launches.FLAGGED_IN_FEED, 'GoPlus only for the newest few');
    assert.equal(f.tokens[7].flags.flags[0].text, 'Flagged as a honeypot');
    assert.equal(f.tokens[8].flags, null);
    assert.match(f.note, /Nothing here is a recommendation or financial advice/);
    assert.deepEqual(launches.parse({ chain: 'solana' }), { error: 'chain must be one of: base, ethereum, arbitrum, bsc.' });
  } finally { discover.tokens = realTokens; discover.flags = realFlags; }
});

test('a buy of a young token gets the bundle check; an established one doesn\'t', async () => {
  const dexscreener = require('../src/providers/dexscreener');
  const ls = require('../src/services/launchSafety');
  const launches = require('../src/services/launches');
  const realMarket = dexscreener.market, realCheck = ls.check;
  let created = hoursAgo(30 * 24), result = null, checks = 0;
  dexscreener.market = async () => ({ source: 'DexScreener', pairs: 1, price_usd: 0.01, liquidity_usd_total: 5000, first_pair_created_at: created });
  ls.check = async () => { checks += 1; if (result instanceof Error) throw result; return result; };
  const flag = (severity, title) => ({ severity, title, evidence: 'e', source: 'Block explorer and RPC' });
  try {
    let r = await launches.forTrade({ chain: 'base', token: T(1) });
    assert.deepEqual([r.young, r.risk, checks], [false, 'ok', 0], 'a month-old token: no bundle check');
    assert.match(r.detail, /30 days ago \(DexScreener\)/);

    created = hoursAgo(5);
    result = { verdict: 'bundle_found', summary: 'A bundle sold.', groups: [{}], sources: ['x'], flags: [flag('critical', 'A bundle bought 30% at launch and has sold 70% of it'), flag('info', 'busy funder')] };
    r = await launches.forTrade({ chain: 'base', token: T(2) });
    assert.deepEqual([r.young, r.risk], [true, 'block']);
    assert.equal(r.flags.length, 1, 'info findings aren\'t risks');

    result = { verdict: 'bundle_found', summary: 'A bundle.', groups: [], sources: [], flags: [flag('high', 'A bundle bought 12% of the supply at launch')] };
    assert.equal((await launches.forTrade({ chain: 'base', token: T(3) })).risk, 'confirm');
    result = { verdict: 'possible_bundle', summary: 'Shared funder.', groups: [], sources: [], flags: [flag('medium', 'Wallets with a shared funder bought 4%')] };
    assert.equal((await launches.forTrade({ chain: 'base', token: T(4) })).risk, 'ok', 'a medium finding is shown, not a stop');

    result = Object.assign(new Error('Too little of the launch could be read'), { status: 503 });
    r = await launches.forTrade({ chain: 'base', token: T(5) });
    assert.deepEqual([r.young, r.risk], [true, 'unknown']);
    assert.match(r.detail, /couldn't run: Too little/);

    created = null; // no pool found: treated as young
    result = { verdict: 'no_bundle_found', summary: 'No bundle.', groups: [], sources: [], flags: [] };
    r = await launches.forTrade({ chain: 'base', token: T(6) });
    assert.deepEqual([r.young, r.risk], [true, 'ok']);
    assert.deepEqual(await launches.forTrade({ chain: 'polygon', token: T(7) }), { young: false, risk: 'ok', detail: 'not checked on this chain' });

    const discover = require('../src/services/discover');
    const realFlags = discover.flags;
    discover.flags = async () => ({ flags: [{ level: 'ok', text: 'None of GoPlus\'s red flags', source: 'GoPlus' }] });
    try {
      created = hoursAgo(2);
      const c = await launches.card({ chain: 'base', token: T(8).toUpperCase().replace('0X', '0x') });
      assert.equal(c.token, T(8));
      assert.equal(c.young, true);
      assert.equal(c.launch_check, `/safety?chain=base&token=${T(8)}#check-card`);
      await assert.rejects(launches.card({ chain: 'base', token: 'nope' }), /contract address/);
    } finally { discover.flags = realFlags; }
  } finally { dexscreener.market = realMarket; ls.check = realCheck; }
});

const DB = process.env.TEST_DATABASE_URL;
test('Meme Watch: liquidity pulled, a new flag, the stop-loss and insiders selling, each with a ready-made sell', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async t => {
  Object.assign(process.env, { DATABASE_URL: DB, JWT_SECRET: 'test-secret', PUBLIC_URL: 'https://rektbull.test' });
  for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];
  const db = require('../src/config/db');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await require('../src/config/migrate').migrate();
  t.after(() => db.getPool().end());

  const MEME = T(7), USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const { rows: [a] } = await db.query(`INSERT INTO accounts (wallet) VALUES ('0x${'ab'.repeat(20)}') RETURNING id, wallet`);
  await db.query(`INSERT INTO positions (account_id, chain, token, amount_raw, cost_usd) VALUES ($1, 'base', $2, $3, 100), ($1, 'base', $4, 1000000, 1)`,
    [a.id, MEME, (1000n * 10n ** 18n).toString(), USDC]);
  await db.query(`INSERT INTO agent_settings (account_id, agent, enabled, next_run_at) VALUES ($1, 'meme_watch', true, now())`, [a.id]);

  // The providers, as stand-ins: price $0.10 (1,000 tokens = $100), $50k liquidity, no flags, one bundle group.
  const market = { source: 'DexScreener', pairs: 1, price_usd: 0.1, liquidity_usd_total: 50000, token_symbol: 'MEME', first_pair_created_at: hoursAgo(3) };
  require('../src/providers/dexscreener').market = async () => ({ ...market });
  let flags = [{ level: 'ok', text: 'None of GoPlus\'s red flags', source: 'GoPlus' }];
  require('../src/services/discover').flags = async () => ({ flags });
  const ls = require('../src/services/launchSafety');
  ls.check = async () => ({ verdict: 'bundle_found', groups: [{ funder: '0x' + 'f0'.repeat(20), funder_kind: 'wallet', bought_pct: 20, holds_pct: 20, wallets: [{ address: '0x' + 'e1'.repeat(20) }] }], flags: [] });
  let held = 20;
  ls.holdingsNow = async (_c, _t, groups) => Object.fromEntries(groups.map(g => [g.funder, held]));
  require('../src/providers/rpc').evmRpc = async () => '0x12'; // decimals() = 18

  const myAgents = require('../src/services/myAgents');
  const run = async () => {
    const { rows: [row] } = await db.query(`SELECT * FROM agent_settings WHERE account_id = $1 AND agent = 'meme_watch'`, [a.id]);
    return myAgents.runOne(row);
  };
  const alerts = async () => (await db.query(`SELECT kind, severity, title, detail FROM monitor_alerts WHERE account_id = $1 ORDER BY id`, [a.id])).rows;

  // First run: a baseline, no alerts; USDC isn't watched.
  let r = await run();
  assert.equal(r.alerts, 0);
  assert.equal(r.result.text, '1 token watched');
  const { rows: [{ snapshot }] } = await db.query(`SELECT snapshot FROM agent_settings WHERE account_id = $1 AND agent = 'meme_watch'`, [a.id]);
  assert.deepEqual(Object.keys(snapshot.positions), [`base:${MEME}`]);
  assert.equal(snapshot.positions[`base:${MEME}`].change_pct, 0);

  // Then: liquidity down 60%, GoPlus calls it a honeypot, the price down 30% (past the default 20% stop).
  market.liquidity_usd_total = 20000; market.price_usd = 0.07;
  flags = [{ level: 'bad', text: 'Flagged as a honeypot: buyers may not be able to sell', source: 'GoPlus' }];
  r = await run();
  let got = await alerts();
  assert.deepEqual(got.map(x => [x.severity, x.title]), [
    ['critical', 'MEME on base: liquidity fell 60% since the last check'],
    ['high', 'MEME on base: down 30%, past your stop-loss of 20%'],
    ['high', 'MEME on base: Flagged as a honeypot: buyers may not be able to sell'],
  ]);
  assert.ok(got.every(x => x.kind === 'meme_watch' && x.detail.sell === `/trade?chain=base&token=${MEME}&side=sell&fraction=100#trade-card`), 'each with a ready-made sell');
  assert.ok(got.every(x => x.detail.reasons.every(re => re.source)), 'each reason names its source');
  const { message } = require('../src/alerts/format');
  assert.equal(message({ ...got[0], wallet: a.wallet }).url, `https://rektbull.test/trade?chain=base&token=${MEME}&side=sell&fraction=100#trade-card`);
  assert.equal(message({ ...got[0], wallet: a.wallet }).action, 'Review the sell');

  // Nothing new: no new alerts. Insiders sell, and their balances are due for a re-read: one critical alert.
  await run();
  assert.equal((await alerts()).length, 3, 'each thing is alerted once');
  held = 8;
  await db.query(`UPDATE agent_settings SET snapshot = jsonb_set(snapshot, '{positions,base:${MEME},insiders_at}', '0') WHERE account_id = $1 AND agent = 'meme_watch'`, [a.id]);
  await run();
  got = await alerts();
  assert.equal(got.length, 4);
  assert.deepEqual([got[3].severity, got[3].title], ['critical', 'MEME on base: launch-bundle wallets are selling (60% of what they bought is gone)']);

  // A token bought on Virtuals' curve: one alert when it graduates (a new token replaces it).
  const CURVE = T(8);
  await db.query(`INSERT INTO positions (account_id, chain, token, amount_raw, cost_usd) VALUES ($1, 'base', $2, $3, 70)`, [a.id, CURVE, (1000n * 10n ** 18n).toString()]); // worth $70 at $0.07: no stop or target
  const lp = require('../src/services/launchpads');
  let state = 'curve';
  lp.identify = async (_c, t) => (t === CURVE ? { launchpad: 'virtuals', name: 'Virtuals', state, agent_token: state === 'graduated' ? T(9) : null, source: 'Virtuals\' Bonding contract onchain (tokenInfo)' } : { launchpad: null });
  await run();
  assert.equal((await alerts()).length, 4, 'still on the curve: nothing to say');
  state = 'graduated';
  await run();
  await run();
  got = await alerts();
  assert.equal(got.length, 5, 'told once');
  assert.match(got[4].title, /graduated from Virtuals' bonding curve/);
  assert.match(got[4].detail.reasons[0].text, new RegExp(`now trades on Uniswap as ${T(9)}`));

  // A token bought on four.meme's curve (BNB Chain): one alert when it graduates to PancakeSwap.
  const FMT = T(6);
  await db.query(`INSERT INTO positions (account_id, chain, token, amount_raw, cost_usd) VALUES ($1, 'bsc', $2, $3, 70)`, [a.id, FMT, (1000n * 10n ** 18n).toString()]);
  let fmState = 'curve', fmReads = 0;
  lp.identify = async (c, t) => {
    if (c === 'bsc' && t === FMT) { fmReads += 1; return { launchpad: 'fourmeme', name: 'four.meme', state: fmState, source: 'four.meme\'s TokenManagerHelper3 contract onchain (getTokenInfo)' }; }
    return { launchpad: null };
  };
  const fmAlerts = async () => (await alerts()).filter(x => /four\.meme/.test(x.title));
  await run();
  assert.ok(fmReads > 0, 'a BNB Chain token\'s launchpad is read');
  assert.equal((await fmAlerts()).length, 0, 'still on the curve: nothing to say');
  fmState = 'graduated';
  await run();
  await run();
  const fmGot = await fmAlerts();
  assert.equal(fmGot.length, 1, 'told once');
  assert.match(fmGot[0].title, new RegExp(`on bsc: it graduated from four\\.meme's bonding curve`));
  assert.match(fmGot[0].detail.reasons[0].text, /now trades on PancakeSwap, the same token/);
  assert.equal(fmGot[0].detail.sell, `/trade?chain=bsc&token=${FMT}&side=sell&fraction=100#trade-card`);
});

test('four.meme (BNB Chain): recognised from its helper contract; its curve; the newest tokens on it', async () => {
  const { ethers } = require('ethers');
  for (const k of Object.keys(require.cache)) if (/src\/(services\/launchpads|services\/launches|providers\/rpc|lib\/cache)\.js$/.test(k)) delete require.cache[k]; // fresh, unstubbed copies
  const rpc = require('../src/providers/rpc');
  const lp = require('../src/services/launchpads');
  const launches = require('../src/services/launches');
  const realRpc = rpc.evmRpc;
  const FM = T('1'), FG = T('2'), FQ = T('3'), DEAD = T('4'), NOTFM = T('5'), QQQB = '0x' + '20'.repeat(20);
  const Z = ethers.ZeroAddress, e18 = n => ethers.parseEther(String(n));
  const SYM = new ethers.Interface(['function symbol() view returns (string)']);
  // getTokenInfo: version, manager, quote, lastPrice, fee rate, min fee, launch time, offers left, max offers, funds, max funds, graduated
  const infos = {
    [FM]: [2, lp.FOURMEME.tokenManager, Z, 0, 100, 0, 0, e18(600_000_000), e18(800_000_000), e18('3.65'), e18('14.6'), false],
    [FG]: [2, lp.FOURMEME.tokenManager, Z, 0, 100, 0, 0, 0, e18(800_000_000), e18('14.6'), e18('14.6'), true],
    [FQ]: [2, lp.FOURMEME.tokenManager, QQQB, 0, 100, 0, 0, e18(400_000_000), e18(800_000_000), e18(1), e18(10), false],
    [DEAD]: [2, lp.FOURMEME.tokenManager, Z, 0, 100, 0, 0, e18(799_999_000), e18(800_000_000), e18('0.0001'), e18('14.6'), false],
  };
  const list = [FG, FQ, DEAD, FM]; // TokenManager2's list, oldest first
  const chains = new Set();
  rpc.evmRpc = async (chain, _m, [{ to, data }]) => {
    chains.add(chain);
    to = to.toLowerCase();
    const sel = data.slice(0, 10);
    const arg = '0x' + data.slice(34, 74);
    if (to === lp.FOURMEME.helper) return lp.HELPER.encodeFunctionResult('getTokenInfo', infos[arg] || [0, Z, Z, 0, 0, 0, 0, 0, 0, 0, 0, false]);
    if (to === lp.FOURMEME.tokenManager && sel === lp.TOKEN_MANAGER.getFunction('_tokenCount').selector) return lp.TOKEN_MANAGER.encodeFunctionResult('_tokenCount', [list.length]);
    if (to === lp.FOURMEME.tokenManager) return lp.TOKEN_MANAGER.encodeFunctionResult('_tokens', [list[Number(BigInt('0x' + data.slice(10)))]]);
    if (sel === SYM.getFunction('symbol').selector) return SYM.encodeFunctionResult('symbol', [to === QQQB ? 'QQQB' : 'FOUR']);
    throw new Error(`unexpected call to ${to}`);
  };
  try {
    const fm = await lp.identify('bsc', FM);
    assert.deepEqual([fm.launchpad, fm.name, fm.state, fm.quote, fm.link], ['fourmeme', 'four.meme', 'curve', 'bnb', `https://four.meme/token/${FM}`]);
    // 800M on the curve, 600M left: 25% sold; 3.65 of 14.6 BNB raised.
    assert.deepEqual(fm.curve, { in_curve: 3.65, in_curve_symbol: 'BNB', graduates_at: 14.6, tokens_left: 600_000_000, progress_pct: 25, buy_tax_pct: 1, sell_tax_pct: 1, min_fee: 0, min_fee_wei: '0' });
    const fg = await lp.identify('bsc', FG);
    assert.deepEqual([fg.state, fg.curve], ['graduated', undefined]);
    assert.match(fg.facts[0], /now trades on PancakeSwap, the same token/);
    const fq = await lp.identify('bsc', FQ);
    assert.deepEqual([fq.quote, fq.quote_symbol], [QQQB, 'QQQB']);
    assert.deepEqual(await lp.identify('bsc', NOTFM), { launchpad: null });
    assert.deepEqual([...chains], ['bsc'], 'read on BNB Chain');

    // The newest on the curve: priced in BNB and with at least 1% sold (graduated, other-quoted and untouched ones left out).
    const c = await launches.curves({ chain: 'bsc' });
    assert.deepEqual(c.tokens.map(t => [t.token, t.ticker, t.launchpad, t.curve.progress_pct]), [[FM, 'FOUR', 'four.meme', 25]]);
    assert.match(c.source, /four\.meme's TokenManager2/);
    assert.match(c.note, /graduate to PancakeSwap/);
    await assert.rejects(launches.curves({ chain: 'ethereum' }), /chain must be one of: base, bsc/);
  } finally { rpc.evmRpc = realRpc; }
});

test('launchpads: Clanker, Zora and Virtuals recognised from their own contracts; a curve\'s progress', async () => {
  const { ethers } = require('ethers');
  for (const k of Object.keys(require.cache)) if (/src\/(services\/launchpads|providers\/rpc)\.js$/.test(k)) delete require.cache[k]; // fresh, unstubbed copies
  const rpc = require('../src/providers/rpc');
  const lp = require('../src/services/launchpads');
  const realRpc = rpc.evmRpc;
  const CL = T('c'), ZO = T('d'), VC = T('e'), VG = T('f'), NONE = T('a'), PAIR = '0x' + '9a'.repeat(20), FFAC = '0x' + '9f'.repeat(20);
  const iface = {
    clanker: new ethers.Interface(['function deploymentInfoForToken(address) view returns (address token, address hook, address locker)']),
    zora: new ethers.Interface(['function getVersionForDeployedCoin(address) view returns (uint8)']),
    pair: new ethers.Interface(['function getReserves() view returns (uint256, uint256)']),
    frouter: new ethers.Interface(['function factory() view returns (address)']),
    ffac: new ethers.Interface(['function buyTax() view returns (uint256)', 'function sellTax() view returns (uint256)']),
  };
  const Z = ethers.ZeroAddress, e18 = n => BigInt(n) * 10n ** 18n;
  const info = (token, trading, onUniswap, agent = Z) => lp.BONDING.encodeFunctionResult('tokenInfo', [T(1), token, PAIR, agent,
    [token, 'n', 'n', 'TICK', e18(1_000_000_000), 0, 0, 0, 0, 0, 0, 0], '', '', '', '', '', '', trading, onUniswap]);
  const calls = [];
  rpc.evmRpc = async (_chain, _m, [{ to, data }]) => {
    to = to.toLowerCase();
    calls.push(to);
    const sel = data.slice(0, 10);
    const arg = '0x' + data.slice(34, 74);
    if (to === lp.ADDR.clanker) return iface.clanker.encodeFunctionResult('deploymentInfoForToken', arg === CL ? [CL, T(2), T(3)] : [Z, Z, Z]);
    if (to === lp.ADDR.zora) return iface.zora.encodeFunctionResult('getVersionForDeployedCoin', [arg === ZO ? 4 : 0]);
    if (to === lp.ADDR.bonding && sel === lp.BONDING.getFunction('tokenInfo').selector) {
      if (arg === VC) return info(VC, true, false);
      if (arg === VG) return info(VG, false, true, T(4));
      return info(Z, false, false);
    }
    if (to === lp.ADDR.bonding) return lp.BONDING.encodeFunctionResult('gradThreshold', [e18(125_000_000)]);
    if (to === PAIR) return iface.pair.encodeFunctionResult('getReserves', [e18(500_000_000), e18(9000)]);
    if (to === lp.ADDR.frouter) return iface.frouter.encodeFunctionResult('factory', [FFAC]);
    if (to === FFAC) return iface.ffac.encodeFunctionResult(data.startsWith(iface.ffac.getFunction('buyTax').selector) ? 'buyTax' : 'sellTax', [1]);
    throw new Error(`unexpected call to ${to}`);
  };
  try {
    const cl = await lp.identify('base', CL);
    assert.deepEqual([cl.launchpad, cl.state, cl.link, cl.locker], ['clanker', 'pool', `https://clanker.world/clanker/${CL}`, T(3)]);
    assert.match(cl.facts[0], /Clanker's locker/);
    const zo = await lp.identify('base', ZO);
    assert.deepEqual([zo.launchpad, zo.version, zo.link], ['zora', 4, `https://zora.co/coin/base:${ZO}`]);
    const vc = await lp.identify('base', VC);
    assert.deepEqual([vc.launchpad, vc.state, vc.ticker], ['virtuals', 'curve', 'TICK']);
    // 1,000M supply, 500M left on the curve, graduating at 125M: 500M of 875M sold.
    assert.deepEqual(vc.curve, { pair: PAIR, virtual_in_curve: 9000, in_curve: 9000, in_curve_symbol: 'VIRTUAL', tokens_left: 500_000_000, graduates_at: 125_000_000, progress_pct: 57.14, buy_tax_pct: 1, sell_tax_pct: 1 });
    const vg = await lp.identify('base', VG);
    assert.deepEqual([vg.state, vg.agent_token, vg.curve], ['graduated', T(4), undefined]);
    assert.deepEqual(await lp.identify('base', NONE), { launchpad: null });
    const before = calls.length;
    assert.deepEqual(await lp.identify('ethereum', CL), { launchpad: null }, 'Base and BNB Chain only');
    assert.equal(calls.length, before, 'and nothing is read for another chain');
  } finally { rpc.evmRpc = realRpc; }
});

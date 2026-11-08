/**
 * Launch Safety, with the block explorer and RPC as stand-ins: the launch
 * found from the first transfers, pools and late buyers set aside, early
 * buyers grouped by funder, a busy funder (an exchange) named but not
 * counted, funding chains traced back to the deployer, what the bundle holds
 * now, a check that read too little refused (so it isn't charged), Solana
 * with a rate-limited RPC retried, and the paid route.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, { JWT_SECRET: 'test', NEW_WALLET_CHECK_CHAINS: '', DATABASE_URL: '' });
const explorer = require('../src/providers/explorer');
const rpc = require('../src/providers/rpc');
const ls = require('../src/services/launchSafety');
ls.RETRIES.splice(0, ls.RETRIES.length, 1, 1, 1);

const a = n => '0x' + String(n).repeat(40).slice(0, 40);
const T = a('7'), D = a('d'), P = a('9'), R = a('5'), F1 = a('f'), X = a('e'), Y = a('c'), Z = a('b');
const A1 = '0x' + 'a1'.repeat(20), A2 = '0x' + 'a2'.repeat(20), A3 = '0x' + 'a3'.repeat(20);
const B1 = '0x' + 'b1'.repeat(20), B2 = '0x' + 'b2'.repeat(20), C = '0x' + 'c1'.repeat(20), I = '0x' + '11'.repeat(20), L = '0x' + '22'.repeat(20);
const ZERO = '0x0000000000000000000000000000000000000000';
const t0 = 1_700_000_000;
const tr = (from, to, value, dt, hash) => ({ from, to, value: String(value), timeStamp: String(t0 + dt), blockNumber: String(100 + dt), hash: hash || `0x${dt}`, tokenDecimal: '0' });

function evmWorld(over = {}) {
  const transfers = over.transfers || [
    tr(ZERO, D, 1000000, 0), tr(D, P, 800000, 10),
    tr(P, A1, 50000, 60, '0xlaunch'), tr(P, A2, 50000, 61), tr(P, A3, 50000, 62),
    tr(P, B1, 30000, 70), tr(P, B2, 30000, 71), tr(P, C, 20000, 80), tr(D, I, 40000, 120), tr(P, R, 1000, 90), // R: a router contract
    tr(P, L, 10000, 7200), // two hours later: not an early buyer
  ];
  const funding = over.funding || { [A1]: F1, [A2]: F1, [A3]: F1, [F1]: D, [B1]: X, [B2]: X, [C]: Y, [Y]: Z, [I]: Z };
  const balances = over.balances || { [A1]: 0, [A2]: 0, [A3]: 50000, [B1]: 30000, [B2]: 30000, [C]: 20000, [I]: 40000 };
  const calls = [];
  explorer.explorerGet = async (_chain, p) => {
    calls.push(p.action);
    if (over.explorerDown) throw new Error('no explorer answered');
    if (p.action === 'getcontractcreation') return { status: '1', result: [{ contractCreator: D }] };
    if (p.action === 'tokentx') return { status: '1', result: transfers };
    if (p.action === 'txlist') return funding[p.address] ? { status: '1', result: [{ from: funding[p.address], to: p.address, value: '1000', isError: '0', timeStamp: String(t0 - 3600), hash: `0xfund${p.address.slice(2, 6)}` }] } : { status: '0', result: [] };
    if (p.action === 'txlistinternal') return { status: '0', result: [] };
    throw new Error(`unexpected ${p.action}`);
  };
  rpc.evmRpc = async (_chain, method, params) => {
    if (method === 'eth_getCode') return over.codesDown ? Promise.reject(new Error('down')) : [P, R].includes(params[0]) ? '0x6080' : '0x';
    if (method === 'eth_getTransactionCount') return params[0] === X ? '0x1388' : '0x5';
    if (method === 'eth_call') {
      const data = params[0].data;
      if (data === '0x18160ddd') return '0x' + (1000000).toString(16);
      const who = '0x' + data.slice(-40);
      return '0x' + (balances[who] ?? 0).toString(16);
    }
    throw new Error(`unexpected ${method}`);
  };
  return calls;
}

test('parsing: chains and addresses', () => {
  assert.deepEqual(ls.parse({ chain: 'Base', token: T.toUpperCase().replace('0X', '0x') }), { chain: 'base', token: T });
  assert.match(ls.parse({ chain: 'tron', token: T }).error, /chain must be one of/);
  assert.match(ls.parse({ chain: 'base', token: '0x12' }).error, /token contract address/);
  assert.match(ls.parse({ chain: 'solana', token: T }).error, /Solana mint/);
});

test('EVM: a bundle funded through the deployer, already selling; an exchange-funded pair named but not counted', async () => {
  evmWorld();
  const r = await ls.check({ chain: 'base', token: T });
  assert.equal(r.verdict, 'bundle_found');
  assert.equal(r.launch.deployer, D);
  assert.equal(r.launch.tx, '0xlaunch', 'the launch is the first transfer that isn\'t a mint or the deployer\'s');
  assert.equal(r.early_buyers.traced, 7, 'the late buyer and the pool are left out');
  assert.equal(r.early_buyers.contracts_set_aside, 1, 'the router (the pool got its liquidity before trading began)');

  const bundle = r.groups.find(g => g.funder === F1);
  assert.deepEqual([bundle.funder_kind, bundle.wallets.length, bundle.bought_pct, bundle.holds_pct, bundle.sold_pct], ['wallet', 3, 15, 5, 67]);
  assert.deepEqual(bundle.linked_to_deployer, { hops: 2, path: [A1, F1, D] });
  const exchange = r.groups.find(g => g.funder === X);
  assert.equal(exchange.funder_kind, 'busy');
  assert.ok(!r.groups.some(g => g.funder === Y), 'a funder of one wallet isn\'t a group');

  assert.equal(r.flags[0].severity, 'critical');
  assert.equal(r.flags[0].title, 'A bundle bought 15% at launch and has sold 67% of it');
  assert.match(r.flags[0].evidence, /^3 early buyers funded from 0xffff…ffff, within 0 hours of each other, bought 15% of the supply in the first hour and hold 5% now\.$/);
  assert.ok(r.flags.some(f => f.title === 'That group traces back to the deployer in 2 steps' && f.evidence === `Funding path: 0xa1a1…a1a1 ← 0xffff…ffff ← 0xdddd…dddd.`));
  assert.ok(r.flags.some(f => f.severity === 'high' && f.title === '4 early buyers are linked to the deployer' && /received the token straight from the deployer/.test(f.evidence)));
  assert.ok(r.flags.some(f => f.severity === 'info' && /2 early buyers were funded from a busy wallet, not counted/.test(f.title)));
  assert.ok(!r.flags.some(f => f.severity !== 'info' && f.evidence.includes('0xeeee')), 'the exchange-funded pair raises nothing');
  assert.ok(r.flags.every(f => f.source), 'every finding names its source');
  assert.match(r.note, /Shared funding isn't proof of intent/);
  assert.deepEqual(r.not_checked, []);
});

test('EVM: a clean launch says so, and only for what it checked', async () => {
  evmWorld({ funding: { [A1]: a('1'), [A2]: a('2'), [A3]: a('3'), [B1]: a('4'), [B2]: a('5'), [C]: a('6'), [I]: a('8') }, transfers: [
    tr(ZERO, D, 1000000, 0), tr(D, P, 900000, 10), tr(P, A1, 1000, 60), tr(P, A2, 1000, 61), tr(P, A3, 1000, 62), tr(P, B1, 1000, 63),
  ] });
  const r = await ls.check({ chain: 'ethereum', token: T });
  assert.equal(r.verdict, 'no_bundle_found');
  assert.equal(r.summary, 'No bundle found among the 4 largest buyers in the first hour: they don\'t share funders or trace back to the deployer in a way that suggests coordination.');
  assert.deepEqual(r.flags, []);
});

test('EVM: too little read is refused (not charged); an explorer that is down too', async () => {
  evmWorld({ codesDown: true });
  await assert.rejects(ls.check({ chain: 'arbitrum', token: T }), err => err.status === 503 && /No early buyers could be read/.test(err.message));
  evmWorld({ explorerDown: true });
  await assert.rejects(ls.check({ chain: 'optimism', token: T }), err => err.status === 503 && /The block explorer didn't answer/.test(err.message) && !/key/.test(err.message));
  evmWorld({ transfers: [] });
  await assert.rejects(ls.check({ chain: 'polygon', token: T }), err => err.status === 404);
});

test('Solana: the curve and program accounts set aside, a shared funder traced to the creator, a rate limit retried', async () => {
  const MINT = 'Mint1111111111111111111111111111111111111111';
  const CREATOR = 'Creator11111111111111111111111111111111111';
  const CURVE = 'Curve111111111111111111111111111111111111111';
  const VAULT = 'Vault111111111111111111111111111111111111111';
  const W1 = 'Wa11et1111111111111111111111111111111111111', W2 = 'Wa11et2222222222222222222222222222222222222', W3 = 'Wa11et3333333333333333333333333333333333333';
  const FUND = 'Funder11111111111111111111111111111111111111';
  const bal = (owner, amount) => ({ mint: MINT, owner, uiTokenAmount: { amount: String(amount) } });
  const swap = (who, amount) => ({ pre: [bal(CURVE, 900000), bal(who, 0)], post: [bal(CURVE, 900000 - amount), bal(who, amount)] });
  const txs = {
    s0: { keys: [CREATOR], ...{ pre: [], post: [bal(CURVE, 900000)] }, time: 100 },
    s1: { keys: [W1], ...swap(W1, 60000), time: 110 },
    s2: { keys: [W2], ...swap(W2, 60000), time: 111 },
    s3: { keys: [W3], ...swap(W3, 5000), time: 112 },
    s4: { keys: [VAULT], ...swap(VAULT, 100000), time: 113 },
  };
  const funding = { [W1]: FUND, [W2]: FUND, [W3]: 'Other1111111111111111111111111111111111111', [FUND]: CREATOR };
  let limited = 1;
  rpc.solanaRpc = async (method, params) => {
    if (method === 'getTransaction' && limited-- > 0) throw Object.assign(new Error('429'), { transient: true });
    if (method === 'getSignaturesForAddress') {
      if (params[0] === MINT) return ['s4', 's3', 's2', 's1', 's0'].map(signature => ({ signature, blockTime: txs[signature].time, err: null }));
      const f = funding[params[0]];
      return f ? [{ signature: `fund:${params[0]}`, blockTime: 50 }] : [];
    }
    if (method === 'getTransaction') {
      const sig = params[0];
      if (sig.startsWith('fund:')) {
        const who = sig.slice(5);
        return { blockTime: 50, transaction: { message: { accountKeys: [{ pubkey: funding[who] }, { pubkey: who }] } }, meta: { preBalances: [5e9, 0], postBalances: [4e9, 1e9] } };
      }
      const t = txs[sig];
      return { blockTime: t.time, transaction: { message: { accountKeys: t.keys.map(pubkey => ({ pubkey })) } }, meta: { preTokenBalances: t.pre, postTokenBalances: t.post, preBalances: [], postBalances: [] } };
    }
    if (method === 'getMultipleAccounts') return { value: params[0].map(k => (k === VAULT ? { owner: 'SomeProgram111111111111111111111111111111111' } : { owner: '11111111111111111111111111111111' })) };
    if (method === 'getTokenSupply') return { value: { amount: '1000000' } };
    if (method === 'getTokenAccountsByOwner') return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: params[0] === W1 ? '60000' : '0' } } } } } }] };
    throw new Error(`unexpected ${method}`);
  };
  const r = await ls.check({ chain: 'solana', token: MINT });
  assert.equal(r.launch.deployer, CREATOR);
  assert.equal(r.early_buyers.traced, 3, 'the curve and the program-owned vault are set aside');
  assert.equal(r.early_buyers.contracts_set_aside, 2);
  const g = r.groups.find(x => x.funder === FUND);
  assert.deepEqual([g.wallets.length, g.bought_pct, g.holds_pct, g.sold_pct], [2, 12, 6, 50]);
  assert.deepEqual(g.linked_to_deployer, { hops: 2, path: [W1, FUND, CREATOR] });
  assert.equal(r.verdict, 'bundle_found', 'two wallets with 12%, traced to the creator');
  assert.ok(r.flags.some(f => f.title === 'Wallets with a shared funder bought 12% at launch' && f.source === 'Solana RPC'));
});

test('the paid route: validated before any charge; needs a way to pay', async () => {
  const server = require('../src/app').createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = body => fetch(base + '/v1/launch/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ chain: 'base', token: '0x1' })).status, 400);
    const r = await post({ chain: 'base', token: T });
    assert.equal(r.status, 402);
    assert.match((await r.json()).message, /Launch check costs \$0\.50/);
  } finally { server.close(); }
});

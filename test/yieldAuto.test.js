/**
 * Automatic yield rebalancing, without a chain: it's off unless switched
 * on; what one pass decides for a permission (exit on a critical warning,
 * the router's interval, the user's onchain limit, deposit vs move); the
 * setup calls only ever name the router. The full flow, with a deployed
 * Yield Router and a real delegation, is in test/yield.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const env = require('../src/config/env');
const auto = require('../src/yield/auto');
const venues = require('../src/yield/venues');

const W = '0x' + '11'.repeat(20);
const ROUTER = '0x' + '22'.repeat(20);
const perm = { id: 'p1', chain_id: 8453, wallet: W, router: ROUTER };
const now = () => Math.floor(Date.now() / 1000);
// Onchain rates (18 decimals) by protocol; the proposals below go to the better-paying venue unless a test says otherwise.
const RATES = { 'aave-v3': 7n * 10n ** 16n, 'compound-v3': 7n * 10n ** 16n, 'spark-susdc': 3n * 10n ** 16n };
const reads = ({ until = now() + 86400, last = 0, interval = 86400, limit = 500n * 10n ** 6n, rates = RATES } = {}) => async fn => {
  if (fn.name === 'validUntil') return [BigInt(until)];
  if (fn.name === 'MIN_GAIN_BPS') return [100n];
  if (fn.name === 'rateOf') return [rates[venues.routerVenues('base')[fn.args[0]].protocol] ?? 0n];
  if (fn.name === 'lastMoveAt') return [BigInt(last)];
  if (fn.name === 'MIN_INTERVAL') return [BigInt(interval)];
  if (fn.name === 'maxPerMove') return [limit];
  throw new Error(fn.name);
};
const positions = list => async () => ({ positions: list, idle: [], not_read: [] });
const proposal = (from, to, amount = '1000.0') => ({
  chain: 'base', asset: 'USDC', amount, amount_usd: Number(amount),
  from: from ? { protocol: from, name: from, apy_pct: 3 } : { protocol: null, name: 'Idle in the wallet', apy_pct: 0 },
  to: { protocol: to, name: to, apy_pct: 7 },
});
const deps = o => ({ read: reads(o.read), positions: positions(o.positions || []), warnings: async () => o.warnings || [], scan: async () => ({ proposals: o.proposals || [] }), evaluate: async () => ({ allowed: true, checks: {} }) });
const id = (protocol, asset = 'USDC') => venues.routerVenues('base').find(v => v.protocol === protocol && v.asset === asset).id;

test('switched off by default: no permission is accepted, and the trade service does nothing', async () => {
  assert.equal(env.yieldAutoEnabled, false);
  assert.deepEqual(await auto.tick(), { off: true });
  await assert.rejects(auto.register({ id: 1, wallet: W }, { chain_id: 8453 }, { sessionKey: W }), err => err.status === 503 && /switched off/.test(err.message));
});

test('a critical warning on a venue the wallet holds: withdraw all of it, whatever the interval or limits', async () => {
  const a = await auto.plan(perm, deps({
    read: { until: 0, last: now() },
    positions: [{ protocol: 'compound-v3', asset: 'USDC', amount: '800.0' }],
    warnings: [{ severity: 'critical', chain: 'base', protocol: 'compound-v3', asset: 'USDC', reason: '99% borrowed' }],
  }));
  assert.deepEqual([a.kind, a.id, a.amount], ['withdraw', id('compound-v3'), ethers.MaxUint256]);
  assert.match(a.reason, /risk watcher: 99% borrowed/);
  const high = await auto.plan(perm, deps({ read: { until: 0 }, positions: [{ protocol: 'compound-v3', asset: 'USDC', amount: '1' }], warnings: [{ severity: 'high', chain: 'base', protocol: 'compound-v3', asset: 'USDC', reason: 'x' }] }));
  assert.ok(high.none, 'only critical warnings move money automatically');
});

test('deposits and moves: only within the router\'s interval and expiry, capped at the user\'s onchain limit', async () => {
  assert.match((await auto.plan(perm, deps({ read: { until: now() - 1 } }))).none, /expired or were revoked/);
  assert.match((await auto.plan(perm, deps({ read: { last: now() - 60 } }))).none, /next deposit or move after/);
  const dep = await auto.plan(perm, deps({ proposals: [proposal(null, 'compound-v3')] }));
  assert.deepEqual([dep.kind, dep.id, dep.amount], ['deposit', id('compound-v3'), 500n * 10n ** 6n], 'capped at 500 USDC');
  const mv = await auto.plan(perm, deps({ proposals: [proposal('spark-susdc', 'aave-v3', '200.0')] }));
  assert.deepEqual([mv.kind, mv.fromId, mv.id, mv.amount], ['move', id('spark-susdc'), id('aave-v3'), 200n * 10n ** 6n]);
  assert.match((await auto.plan(perm, deps({ read: { limit: 0n }, proposals: [proposal(null, 'compound-v3')] }))).none, /no move passes/, 'an asset without a limit is never touched');
  const other = await auto.plan(perm, deps({ proposals: [{ ...proposal(null, 'aave-v3'), chain: 'ethereum' }] }));
  assert.ok(other.none, 'only proposals on the permission\'s own chain');
});

test('only what the router itself would allow, by the venues\' onchain rates (no rewards): the best venue for a deposit, 1 point more for a move', async () => {
  // Spark pays 3% onchain while the others pay 7%: a deposit there would be refused by the router (NotBestVenue).
  const worse = await auto.plan(perm, deps({ proposals: [proposal(null, 'spark-susdc'), proposal(null, 'compound-v3')] }));
  assert.deepEqual([worse.kind, worse.id], ['deposit', id('compound-v3')], 'skips to the next proposal the router accepts');
  // Within 1 point of the best is still allowed.
  const near = await auto.plan(perm, deps({ read: { rates: { ...RATES, 'spark-susdc': 6n * 10n ** 16n + 1n } }, proposals: [proposal(null, 'spark-susdc')] }));
  assert.equal(near.kind, 'deposit');
  // A move whose gain shows only off-chain (rewards) is skipped: onchain, Aave pays no more than Compound.
  assert.match((await auto.plan(perm, deps({ proposals: [proposal('compound-v3', 'aave-v3')] }))).none, /no move passes/);
});

test('the redeem call: the DelegationManager, one execution, only the router', () => {
  const d = { delegate: W, delegator: W, authority: ethers.ZeroHash, caveats: [], salt: '1', signature: '0x' };
  const c = auto.redeemCall({ ...perm, delegation: d }, { kind: 'move', fromId: 3, id: 2, amount: 5n });
  const DM = new ethers.Interface(['function redeemDelegations(bytes[], bytes32[], bytes[])']);
  const [, , executions] = DM.decodeFunctionData('redeemDelegations', c.data);
  assert.equal(executions.length, 1);
  assert.equal(ethers.dataSlice(executions[0], 0, 20).toLowerCase(), ROUTER, 'the execution targets the router');
  assert.equal(ethers.dataSlice(executions[0], 52, 56), auto.ROUTER.getFunction('move').selector);
});

test('setup calls only ever name the router (approvals, Comet\'s allow, the user\'s limits)', () => {
  env.yieldRouters = { 8453: ROUTER };
  try {
    const s = auto.setupCalls(8453, { limits: { USDC: 1000 }, days: 90 });
    const I = new ethers.Interface(['function approve(address,uint256)', 'function allow(address,bool)', 'function setLimits(address[],uint256[],uint64)']);
    for (const c of s.calls) {
      const d = I.parseTransaction({ data: c.data });
      if (d.name === 'setLimits') {
        assert.equal(c.to, ROUTER);
        assert.ok(Number(d.args[2]) <= now() + 30 * 86400 + 5, 'at most 30 days');
      } else assert.equal(d.args[0].toLowerCase(), ROUTER);
    }
    assert.ok(s.calls.some(c => /Compound/.test(c.label)));
    assert.deepEqual(s.delegation.selectors, auto.SELECTORS);
  } finally { env.yieldRouters = {}; }
  assert.throws(() => auto.setupCalls(8453), /isn't deployed/);
});

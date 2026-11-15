/**
 * The live launch feed on Solana (services/solanaLaunches.js): pump.fun's new
 * coins, the curves nearest to graduating and the coins that just graduated,
 * with GeckoTerminal and the chain played by stand-ins. Curve and Global
 * account layouts are the ones read from mainnet on 15 November 2026.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, { DATABASE_URL: '' }); // the in-memory cache only
const gt = require('../src/providers/geckoterminal');
const rpc = require('../src/providers/rpc');
const sl = require('../src/services/solanaLaunches');

const PUMP = sl.PUMP;
const ago = s => new Date(Date.now() - s * 1000).toISOString();
const mint = n => require('../src/lib/base58').encode(Buffer.alloc(32, n)); // a valid address per number
const pool = (dex, token, symbol, createdAgo, quote = 'SOL') => ({ pool: `pool-${dex}-${token}`, dex, token: { address: token, symbol, name: symbol }, quote, created_at: ago(createdAgo) });

/** A bonding curve account: real tokens left at offset 24, real SOL at 32, complete at 48. */
const curve = (left, sol, complete = false) => { const b = Buffer.alloc(150); b.writeBigUInt64LE(BigInt(left), 24); b.writeBigUInt64LE(BigInt(sol), 32); b[48] = complete ? 1 : 0; return { owner: PUMP, data: [b.toString('base64'), 'base64'] }; };
const GLOBAL = (() => { const b = Buffer.alloc(200); b.writeBigUInt64LE(793_100_000_000_000n, 89); b.writeBigUInt64LE(95n, 105); return { owner: PUMP, data: [b.toString('base64'), 'base64'] }; })();

test('the Solana feed: new pump.fun coins, curves by how much is sold, graduations the chain confirms', async t => {
  const NEW1 = mint(3), NEW2 = mint(4), USDCQ = mint(5), OLD = mint(6), GRAD = mint(7), NOTGRAD = mint(8), BUSY = mint(9);
  const curveAt = {};
  for (const m of [GRAD, NOTGRAD]) curveAt[await sl.curveOf(m)] = m;
  const realNew = gt.newPoolsPage, realDex = gt.dexPools, realRpc = rpc.solanaRpc;
  t.after(() => { gt.newPoolsPage = realNew; gt.dexPools = realDex; rpc.solanaRpc = realRpc; });
  const pages = [];
  gt.newPoolsPage = async (chain, page) => {
    assert.equal(chain, 'solana');
    pages.push(page);
    return page === 1
      ? [pool('pump-fun', NEW1, 'NEW1', 30), pool('pump-fun', USDCQ, 'USDQ', 40, 'USDC'), pool('meteora-dbc', mint(10), 'MET', 50), pool('pumpswap', GRAD, 'GRAD', 60), pool('pumpswap', NOTGRAD, 'NOTG', 70)]
      : [pool('pump-fun', NEW2, 'NEW2', 90), pool('pump-fun', OLD, 'OLD', 2 * 3600)];
  };
  gt.dexPools = async (chain, dex) => (dex === 'pump-fun' ? [pool('pump-fun', BUSY, 'BUSY', 5 * 3600)] : []);
  rpc.solanaRpc = async (method, params) => {
    if (method === 'getAccountInfo') { assert.equal(params[0], '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf'); return { value: GLOBAL }; }
    assert.equal(method, 'getMultipleAccounts');
    const [addresses, { encoding }] = params;
    if (encoding === 'jsonParsed') return { value: addresses.map(a => ({ data: { parsed: { info: { mintAuthority: null, freezeAuthority: a === NEW2 ? 'Fr33ze1111111111111111111111111111111111111' : null } } } })) };
    return {
      value: addresses.map(a => {
        if (curveAt[a] === GRAD) return curve(0, 85_000_000_000, true);
        if (curveAt[a] === NOTGRAD) return curve(1, 1, false);
        if (a === `pool-pump-fun-${BUSY}`) return curve(79_310_000_000_000, 70_000_000_000); // 90% sold
        if (a === `pool-pump-fun-${NEW1}`) return curve(713_790_000_000_000, 3_000_000_000); // 10% sold
        if (a === `pool-pump-fun-${NEW2}`) return curve(793_100_000_000_000, 0); // nothing sold yet
        return null;
      }),
    };
  };

  const r = await sl.live();
  assert.deepEqual(pages, [1, 2], 'two pages of the newest pools, one after the other');
  const { new: fresh, graduating, graduated } = r.columns;
  assert.deepEqual(fresh.items.map(i => i.symbol), ['NEW1', 'NEW2'], 'pump.fun curves priced in SOL from the last hour, newest first');
  assert.ok(fresh.items.every(i => i.launchpad_name === 'pump.fun' && i.chain === 'solana'));
  assert.deepEqual(fresh.items[0].flags.flags.map(f => f.text), ['No mint or freeze authority left']);
  assert.deepEqual(fresh.items[1].flags.flags.map(f => [f.level, f.text]), [['bad', 'Its issuer can freeze any holder\'s tokens']]);
  assert.deepEqual(graduating.items.map(i => [i.symbol, i.progress_pct, i.in_curve]), [['BUSY', 90, 70], ['NEW1', 10, 3], ['NEW2', 0, 0]], 'by how much of the 793.1 million is sold');
  assert.match(graduating.source, /793\.1 million tokens/);
  assert.deepEqual(graduated.items.map(i => i.symbol), ['GRAD'], 'a PumpSwap pool counts only when the coin\'s curve is complete');
  assert.match(r.note, /not a recommendation or financial advice|Nothing here is a recommendation/);
  // Through the Launches desk's own route.
  assert.equal((await require('../src/services/liveLaunches').live({ chain: 'solana' })).chain, 'solana');
});

test('a curve account is read only when pump.fun owns it', () => {
  assert.equal(sl.decodeCurve({ owner: '11111111111111111111111111111111', data: curve(1, 1).data }), null);
  assert.equal(sl.decodeCurve(null), null);
  assert.deepEqual(sl.decodeCurve(curve(5, 6, true)), { real_token: 5n, real_sol: 6n, complete: true });
});

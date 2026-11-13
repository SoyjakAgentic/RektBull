/**
 * The live launch feed: the launchpads' own events on a stand-in chain, read
 * incrementally, decoded into the three columns, with what it says when the
 * chain can't be read. No network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
require('../src/config/env').databaseUrl = ''; // the in-process cache only

const rpc = require('../src/providers/rpc');
const cache = require('../src/lib/cache');
const discover = require('../src/services/discover');
const launchpads = require('../src/services/launchpads');
const L = require('../src/services/liveLaunches');

const pad = (chain, id) => L.PADS[chain].find(p => p.id === id);
const addr = n => '0x' + n.toString(16).padStart(40, '0');

/** A stand-in chain: blocks every `spb` seconds up to `head`, and the logs in them. */
function fakeChain(spb) {
  const c = { head: 1000000, spb, logs: [], calls: [], fail: null };
  c.now = () => Math.floor(Date.now() / 1000);
  c.ts = n => c.now() - (c.head - n) * spb;
  c.emit = (chain, id, name, args, block) => {
    const p = pad(chain, id);
    const { data, topics } = p.iface.encodeEventLog(p.iface.getEvent(name), args);
    c.logs.push({ address: p.address, topics, data, blockNumber: '0x' + block.toString(16), transactionHash: ethers.id(`${name}:${block}:${c.logs.length}`), logIndex: '0x' + c.logs.length.toString(16) });
  };
  return c;
}

test('the live launch feed', async t => {
  const saved = { logs: rpc.evmLogs, rpc: rpc.evmRpc, flags: discover.flags, fm: launchpads.fourMemeCurve, curve: launchpads.newestOnCurve };
  t.after(() => Object.assign(rpc, { evmLogs: saved.logs, evmRpc: saved.rpc }) && Object.assign(launchpads, { fourMemeCurve: saved.fm, newestOnCurve: saved.curve }) && (discover.flags = saved.flags));
  let chain;
  rpc.evmLogs = async (_c, f) => {
    if (chain.fail) throw new Error(chain.fail);
    const [a, b] = [parseInt(f.fromBlock, 16), parseInt(f.toBlock, 16)];
    chain.calls.push([a, b, f.topics[0].length]);
    return chain.logs.filter(l => { const n = parseInt(l.blockNumber, 16); return n >= a && n <= b && f.address.includes(l.address) && f.topics[0].includes(l.topics[0]); });
  };
  const ERC20 = new ethers.Interface(['function symbol() view returns (string)', 'function name() view returns (string)']);
  rpc.evmRpc = async (_c, method, params) => {
    if (method === 'eth_getBlockByNumber') { const n = params[0] === 'latest' ? chain.head : parseInt(params[0], 16); return { number: '0x' + n.toString(16), timestamp: '0x' + chain.ts(n).toString(16) }; }
    if (method === 'eth_call') { const fn = ERC20.parseTransaction({ data: params[0].data }).name; return ERC20.encodeFunctionResult(fn, [fn === 'symbol' ? 'VIRT' : 'A Virtuals coin']); }
    throw new Error(`unexpected ${method}`);
  };
  let flagsAsked = 0;
  discover.flags = async ({ token }) => { flagsAsked++; return { token, flags: [{ level: 'warn', text: 'More can be minted', source: 'GoPlus' }] }; };
  const fresh = () => cache._memory.clear();

  await t.test('BNB Chain: four.meme\'s launches, the curves being bought nearest to graduating, and its graduations', async () => {
    fresh();
    chain = fakeChain(0.45); // about 8,000 blocks an hour
    const H = chain.head;
    for (let i = 0; i < 8; i++) chain.emit('bsc', 'fourmeme', 'TokenCreate', [addr(0xc0), addr(0x100 + i), i, `Coin ${i}`, `C${i}`, 10n ** 27n, 0, 0], H - 7000 + i * 100);
    chain.emit('bsc', 'fourmeme', 'TokenCreate', [addr(0xc0), addr(0x999), 9, 'Too old', 'OLD', 10n ** 27n, 0, 0], H - 9000); // over an hour ago
    chain.emit('bsc', 'fourmeme', 'TokenPurchase', [addr(0x101), addr(0xb0), 1, 1, 1, 1, 10n ** 26n, 20n * 10n ** 18n], H - 500);
    chain.emit('bsc', 'fourmeme', 'TokenPurchase', [addr(0x102), addr(0xb0), 1, 1, 1, 1, 10n ** 26n, 5n * 10n ** 18n], H - 400);
    chain.emit('bsc', 'fourmeme', 'TokenPurchase', [addr(0x101), addr(0xb0), 1, 1, 1, 1, 10n ** 25n, 23n * 10n ** 18n], H - 300); // the same curve again: the latest counts
    chain.emit('bsc', 'fourmeme', 'LiquidityAdded', [addr(0x200), 2n * 10n ** 26n, addr(0), 24n * 10n ** 18n], H - 100000); // 12.5 hours ago
    launchpads.fourMemeCurve = async token => ({ state: 'curve', quote: 'bnb', curve: { progress_pct: token === addr(0x101) ? 95.5 : 40, in_curve: 23, in_curve_symbol: 'BNB' } });

    const r = await L.live({ chain: 'bsc' });
    assert.equal(r.chain_name, 'BNB Chain');
    assert.deepEqual(r.columns.new.items.map(i => i.symbol), ['C7', 'C6', 'C5', 'C4', 'C3', 'C2', 'C1', 'C0'], 'newest first, the last hour only');
    const first = r.columns.new.items[0];
    assert.deepEqual([first.launchpad, first.token, first.name, first.creator], ['fourmeme', addr(0x107), 'Coin 7', addr(0xc0)]);
    assert.ok(Math.abs(Date.parse(first.at) - (Date.now() - 6300 * 450)) < 3000, 'when it launched, from the block');
    assert.equal(r.columns.new.items.filter(i => i.flags).length, 6, 'GoPlus\'s flags on the six newest cards');
    assert.deepEqual(r.columns.graduating.items.map(i => [i.token, i.progress_pct]), [[addr(0x101), 95.5], [addr(0x102), 40]], 'nearest to graduating first, confirmed with the helper');
    assert.match(r.columns.graduating.source, /TokenPurchase/);
    // The first read covers the last hour, then the graduations a few chunks further back each time.
    assert.ok(chain.calls.every(([a, b]) => b - a < 10000), 'small ranges only');
    assert.equal(r.columns.graduated.items.length, 0, 'the graduation 12.5 hours back isn\'t reached on the first read');
    assert.ok(r.columns.graduated.hours_covered > 1 && r.columns.graduated.hours_covered < 24);

  });

  await t.test('incremental: each read asks only for the blocks since the last one; nothing is listed twice', async () => {
    fresh();
    chain = fakeChain(0.45);
    const H = chain.head;
    chain.emit('bsc', 'fourmeme', 'TokenCreate', [addr(0xc0), addr(0x300), 1, 'One', 'ONE', 10n ** 27n, 0, 0], H - 10);
    chain.emit('bsc', 'fourmeme', 'LiquidityAdded', [addr(0x400), 1n, addr(0), 1n], H - 150000); // 18.75 hours ago
    let st = await L.advance('bsc', null);
    assert.deepEqual(st.launches.map(i => i.symbol), ['ONE']);
    const firstNew = chain.calls.filter(c => c[2] === 3);
    assert.deepEqual([firstNew[0][0], firstNew.at(-1)[1]], [H - 8000 + 1, H], 'the first read: the last hour');
    chain.head += 30;
    chain.emit('bsc', 'fourmeme', 'TokenCreate', [addr(0xc0), addr(0x301), 2, 'Two', 'TWO', 10n ** 27n, 0, 0], H + 25);
    chain.calls.length = 0;
    st = await L.advance('bsc', JSON.parse(JSON.stringify(st)));
    assert.deepEqual(chain.calls.filter(c => c[2] === 3), [[H + 1, H + 30, 3]], 'then only the new blocks');
    assert.deepEqual(st.launches.map(i => i.symbol), ['TWO', 'ONE']);
    // Graduations: three chunks further back per read, until 24 hours are covered; found once, kept once.
    for (let k = 0; k < 10 && st.graduated_hours < 24; k++) st = await L.advance('bsc', JSON.parse(JSON.stringify(st)));
    assert.equal(st.graduated_hours, 24);
    assert.deepEqual(st.graduated.map(i => i.token), [addr(0x400)]);
    chain.calls.length = 0;
    st = await L.advance('bsc', JSON.parse(JSON.stringify(st)));
    assert.equal(chain.calls.filter(c => c[2] === 1).length, 0, 'no more reading back once 24 hours are covered');
    assert.deepEqual(st.graduated.map(i => i.token), [addr(0x400)], 'not listed twice');
    // A gap longer than the window (nobody watching for hours) starts the window afresh rather than reading it all,
    // and the graduations in the gap are read back again.
    chain.emit('bsc', 'fourmeme', 'LiquidityAdded', [addr(0x401), 1n, addr(0), 1n], chain.head + 50000); // during the gap
    chain.head += 100000;
    chain.calls.length = 0;
    st = await L.advance('bsc', JSON.parse(JSON.stringify(st)));
    const after = chain.calls.filter(c => c[2] === 3);
    assert.equal(after[0][0], chain.head - 8000 + 1);
    assert.deepEqual(st.launches, [], 'launches over an hour old are dropped');
    for (let k = 0; k < 10 && st.graduated_hours < 24; k++) st = await L.advance('bsc', JSON.parse(JSON.stringify(st)));
    assert.deepEqual(st.graduated.map(i => i.token), [addr(0x401)], 'the gap\'s graduation found; the one now over 24 hours old dropped');
  });

  await t.test('Base: Clanker, Zora and Virtuals launches; a Virtuals graduation; names read from the token when the event has none', async () => {
    fresh();
    chain = fakeChain(2);
    const H = chain.head;
    const p = pad('base', 'clanker');
    chain.emit('base', 'clanker', 'TokenCreated', [addr(0xa1), addr(0x501), addr(0xa2), 'ipfs://x', 'Clank', 'CLK', '{}', '{}', 0, addr(0), ethers.ZeroHash, addr(0x4200), addr(0), addr(0), 0, []], H - 100);
    chain.emit('base', 'zora', 'CoinCreatedV4', [addr(0xb1), addr(0xb2), addr(0), addr(0), 'ipfs://y', 'Zed', 'ZED', addr(0x502), [addr(0), addr(1), 0, 0, addr(0)], ethers.ZeroHash, '1'], H - 50);
    chain.emit('base', 'virtuals', 'Launched', [addr(0x503), addr(0x504), 50000000001n, 0, 0, [0, 0, false, 1, true]], H - 20); // BondingV5's: a "Project 60 days" launch
    chain.emit('base', 'virtuals', 'Graduated', [addr(0x505), addr(0x506)], H - 30);
    launchpads.newestOnCurve = async () => [{ token: addr(0x507), ticker: 'CURVE', curve: { progress_pct: 61.2, in_curve: 4000, in_curve_symbol: 'VIRTUAL' } }];
    assert.ok(p);
    const r = await L.live({ chain: 'base' });
    assert.deepEqual(r.columns.new.items.map(i => [i.launchpad, i.symbol, i.creator]), [['virtuals', 'VIRT', null], ['zora', 'ZED', addr(0xb1)], ['clanker', 'CLK', addr(0xa2)]]);
    assert.equal(r.columns.new.items[0].project_60_days, true, 'its card says Virtuals\' operators can drain it');
    assert.deepEqual(r.columns.graduated.items.map(i => [i.token, i.agent_token]), [[addr(0x505), addr(0x506)]]);
    assert.deepEqual(r.columns.graduating.items.map(i => [i.symbol, i.progress_pct]), [['CURVE', 61.2]]);
    assert.match(r.columns.graduated.source, /Clanker and Zora coins trade on Uniswap from launch/);
  });

  await t.test('the chain can\'t be read: the last good list stands, saying why; with none yet, a 503 that says so', async () => {
    fresh();
    chain = fakeChain(0.45);
    chain.emit('bsc', 'fourmeme', 'TokenCreate', [addr(0xc0), addr(0x600), 1, 'Kept', 'KEPT', 10n ** 27n, 0, 0], chain.head - 10);
    launchpads.fourMemeCurve = async () => null;
    await L.live({ chain: 'bsc' });
    cache._memory.delete('launches:live:read:bsc'); cache._memory.delete('launches:live:view:bsc'); // 10 seconds later
    chain.fail = 'eth_getLogs on bsc: every endpoint failed (limit exceeded)';
    const r = await L.live({ chain: 'bsc' });
    assert.match(r.not_checked, /couldn't be read just now: eth_getLogs on bsc: every endpoint failed/);
    assert.deepEqual(r.columns.new.items.map(i => i.symbol), ['KEPT']);
    fresh();
    await assert.rejects(L.live({ chain: 'bsc' }), e => e.status === 503 && /every endpoint failed/.test(e.message));
    chain.fail = null;
  });

  await t.test('a chain it doesn\'t read launchpads on is refused, naming the ones it does', async () => {
    await assert.rejects(L.live({ chain: 'ethereum' }), e => e.status === 400 && /Base and BNB Chain/.test(e.message));
  });

  await t.test('flags are asked for once per token, not on every read', async () => {
    fresh();
    chain = fakeChain(0.45);
    chain.emit('bsc', 'fourmeme', 'TokenCreate', [addr(0xc0), addr(0x700), 1, 'F', 'F', 10n ** 27n, 0, 0], chain.head - 10);
    flagsAsked = 0;
    await L.live({ chain: 'bsc' });
    for (const k of ['launches:live:read:bsc', 'launches:live:view:bsc']) cache._memory.delete(k);
    await L.live({ chain: 'bsc' });
    assert.equal(flagsAsked, 1);
  });

  await t.test('decode: a log from another contract, or another event, is not an item', () => {
    const p = pad('bsc', 'fourmeme');
    const { data, topics } = p.iface.encodeEventLog(p.iface.getEvent('TokenCreate'), [addr(1), addr(2), 1, 'a', 'b', 1, 0, 0]);
    assert.equal(L.decode('bsc', { address: addr(0xdead), topics, data, blockNumber: '0x1', transactionHash: ethers.ZeroHash, logIndex: '0x0' }, new Date().toISOString()), null);
    assert.equal(L.decode('bsc', { address: p.address, topics: [ethers.id('Other(uint256)')], data: '0x', blockNumber: '0x1', transactionHash: ethers.ZeroHash, logIndex: '0x0' }, new Date().toISOString()), null);
  });
});

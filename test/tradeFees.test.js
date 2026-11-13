/**
 * Protected sending: the fee each speed offers, read from the chain's recent
 * blocks, and the private networks offered per chain. No network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/config/env').databaseUrl = '';
const rpc = require('../src/providers/rpc');
const cache = require('../src/lib/cache');
const fees = require('../src/trade/fees');

const gwei = n => BigInt(Math.round(n * 1e9));
const hex = v => '0x' + BigInt(v).toString(16);

test('protected sending', async t => {
  const saved = rpc.evmRpc;
  t.after(() => { rpc.evmRpc = saved; });
  let asked = [];
  // 20 blocks: the 75th and 95th percentile priority fees each paid, and the base fees (the last one is the next block's).
  let history = {
    reward: Array.from({ length: 20 }, (_, i) => [hex(gwei(0.1 + i * 0.01)), hex(gwei(1 + i * 0.1))]),
    baseFeePerGas: [...Array.from({ length: 20 }, () => hex(gwei(10))), hex(gwei(12))],
  };
  rpc.evmRpc = async (chain, method, params) => { asked.push([chain, method, params]); return history; };

  await t.test('fast and fastest: the median of the chain\'s last 20 blocks at the 75th and 95th percentile; the max fee covers the next base fee twice', async () => {
    cache._memory.clear();
    const fast = await fees.suggest('ethereum', 'fast');
    assert.deepEqual(asked[0], ['ethereum', 'eth_feeHistory', ['0x14', 'latest', [75, 95]]]);
    assert.equal(BigInt(fast.max_priority_fee_per_gas), gwei(0.2), 'the median of 0.10 to 0.29 gwei');
    assert.equal(BigInt(fast.base_fee_per_gas), gwei(12), 'the next block\'s base fee');
    assert.equal(BigInt(fast.max_fee_per_gas), gwei(24.2));
    assert.match(fast.source, /75th-percentile priority fee of ethereum's last 20 blocks/);
    const fastest = await fees.suggest('ethereum', 'fastest');
    assert.equal(BigInt(fastest.max_priority_fee_per_gas), gwei(2));
    assert.equal(asked.length, 1, 'the chain is read once for both (cached 6 seconds)');
  });

  await t.test('never a priority fee of 0 (Flashbots Protect drops those); BNB Chain\'s base fee of 0 is fine', async () => {
    cache._memory.clear();
    history = { reward: Array.from({ length: 20 }, () => ['0x0', '0x0']), baseFeePerGas: Array.from({ length: 21 }, () => '0x0') };
    const r = await fees.suggest('bsc', 'fast');
    assert.equal(r.max_priority_fee_per_gas, '0x1');
    assert.equal(r.max_fee_per_gas, '0x1');
  });

  await t.test('standard leaves the fee to the wallet; Arbitrum offers none (it orders by arrival); an unknown speed is refused', async () => {
    asked = [];
    assert.match((await fees.suggest('ethereum', 'standard')).none, /wallet chooses/);
    assert.match((await fees.suggest('arbitrum', 'fastest')).none, /Arbitrum orders transactions as they arrive/);
    assert.equal(asked.length, 0, 'nothing read for either');
    await assert.rejects(fees.suggest('base', 'warp'), e => e.status === 400 && /standard, fast, fastest/.test(e.message));
  });

  await t.test('the protected networks: Flashbots Protect on Ethereum, PancakeSwap MEV Guard and 48 Club on BNB Chain, none needed on Base or Arbitrum', () => {
    const P = fees.PROTECTED;
    assert.deepEqual(P.ethereum.networks.map(n => [n.rpc, n.chain_id]), [['https://rpc.flashbots.net/fast', '0x1']]);
    assert.deepEqual(P.bsc.networks.map(n => [n.rpc, n.chain_id]), [['https://bscrpc.pancakeswap.finance', '0x38'], ['https://rpc.48.club', '0x38']]);
    assert.deepEqual(P.bsc.detect, { network: '48club', call: { to: '0x0000000000000000000000000000000000000048', data: '0x' }, answer: '0x30' });
    for (const c of ['base', 'arbitrum']) { assert.deepEqual(P[c].networks, []); assert.match(P[c].note, /no public mempool/); }
    for (const n of [...P.ethereum.networks, ...P.bsc.networks]) assert.match(n.docs, /^https:\/\/docs\./, 'each names its documentation');
  });
});

/**
 * A wallet's yield positions on every venue and chain, and what sits idle
 * in it, in tokens and dollars (Aave's oracle prices). Read onchain in one
 * Multicall3 batch per chain. Anything that couldn't be read is listed in
 * `not_read`, never assumed to be zero.
 */
const { ethers } = require('ethers');
const { multicall } = require('../services/approvals');
const rpc = require('../providers/rpc');
const venues = require('./venues');
const rates = require('./rates');

const ERC20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const VAULT = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function convertToAssets(uint256) view returns (uint256)']);
const r2 = x => Math.round(x * 100) / 100;

async function readChain(chain, wallet) {
  const positions = []; const idle = []; const notRead = [];
  const reads = [];
  for (const v of venues.VENUES.filter(x => x.chain === chain)) {
    for (const asset of v.assets) reads.push({ kind: 'position', v, asset, call: { target: venues.positionToken(v, asset), iface: ERC20, fn: 'balanceOf', args: [wallet] } });
  }
  for (const [asset, t] of Object.entries(venues.TOKENS[chain])) reads.push({ kind: 'idle', asset, call: { target: t.address, iface: ERC20, fn: 'balanceOf', args: [wallet] } });
  let results;
  try { results = await multicall(chain, reads.map(r => r.call)); } catch (err) {
    return { positions, idle, notRead: [{ chain, what: 'everything', reason: err.message }] };
  }
  const price = async asset => rates.priceUsd(chain, asset).catch(() => null);
  for (let i = 0; i < reads.length; i++) {
    const r = reads[i]; const out = results[i];
    const label = r.kind === 'position' ? `${r.v.name} ${r.asset}` : `${r.asset} in the wallet`;
    if (!out.ok) { notRead.push({ chain, what: label, reason: 'the balance couldn\'t be read' }); continue; }
    let held = BigInt(out.value[0]);
    if (held === 0n) continue;
    const t = venues.tokenOf(chain, r.asset);
    if (r.kind === 'position' && r.v.kind === 'spark') {
      // Vault shares → the USDC they're worth now.
      const [a] = await multicall(chain, [{ target: r.v.vault, iface: VAULT, fn: 'convertToAssets', args: [held] }]).catch(() => [{ ok: false }]);
      if (!a.ok) { notRead.push({ chain, what: label, reason: 'what the shares are worth couldn\'t be read' }); continue; }
      held = BigInt(a.value[0]);
    }
    const p = t.stable ? (await price(r.asset)) ?? 1 : await price(r.asset);
    const amount = ethers.formatUnits(held, t.decimals);
    const row = { chain, asset: r.asset, amount, units: held.toString(), usd: p === null ? null : r2(Number(amount) * p) };
    if (r.kind === 'position') positions.push({ ...row, protocol: r.v.protocol, name: r.v.name, status: r.v.status });
    else idle.push(row);
  }
  try {
    const wei = BigInt(await rpc.evmRpc(chain, 'eth_getBalance', [wallet, 'latest']));
    const p = await price('WETH');
    idle.push({ chain, asset: 'ETH', gas: true, amount: ethers.formatEther(wei), units: wei.toString(), usd: p === null ? null : r2(Number(ethers.formatEther(wei)) * p) });
  } catch (err) { notRead.push({ chain, what: 'ETH for gas', reason: err.message }); }
  return { positions, idle, notRead };
}

async function read(wallet, { chains = Object.keys(venues.CHAINS) } = {}) {
  wallet = String(wallet).toLowerCase();
  const parts = await Promise.all(chains.map(c => readChain(c, wallet)));
  const positions = parts.flatMap(p => p.positions);
  const idle = parts.flatMap(p => p.idle);
  return {
    wallet, read_at: new Date().toISOString(), positions, idle,
    total_in_positions_usd: r2(positions.reduce((s, p) => s + (p.usd || 0), 0)),
    not_read: parts.flatMap(p => p.notRead),
    source: 'balances read onchain (Multicall3); prices from each chain\'s Aave oracle',
  };
}

module.exports = { read };

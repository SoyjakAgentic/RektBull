/**
 * The calls into each venue, built here and never signed here (carried over
 * from soyjak-agentic's defiCalls.js). The user's wallet signs them.
 *   - Gas ceilings per venue and step, also used by the rules to price a move.
 *   - Slippage bounds where a price can move: Spark's vault (through Sky's
 *     PSM) takes at least its own preview's shares on deposit and gives up
 *     at most its preview's shares on withdrawal. Aave and Compound move 1:1.
 *   - Refusals before anything is built: more than the position holds
 *     (Compound would borrow the rest), a Spark vault whose asset isn't the
 *     one listed.
 *   - Every recipient is the wallet itself: deposits are on its behalf,
 *     withdrawals pay it.
 */
const { ethers } = require('ethers');
const { multicall } = require('../services/approvals');
const venues = require('./venues');
const rates = require('./rates');

const DEFAULT_SLIPPAGE_BPS = 50;
const GAS = {
  approve: 100000n,
  transfer: 70000n,
  aave: { deposit: 300000n, withdraw: 300000n },
  comet: { deposit: 250000n, withdraw: 250000n },
  spark: { deposit: 500000n, withdraw: 500000n },
};

const ERC20 = new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)',
]);
const AAVE = new ethers.Interface(['function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)', 'function withdraw(address asset, uint256 amount, address to) returns (uint256)']);
const COMET = new ethers.Interface(['function supply(address asset, uint amount)', 'function withdraw(address asset, uint amount)', 'function balanceOf(address owner) view returns (uint256)']);
const SPARK = new ethers.Interface([
  'function asset() view returns (address)', 'function balanceOf(address owner) view returns (uint256)',
  'function previewDeposit(uint256 assets) view returns (uint256)', 'function previewWithdraw(uint256 assets) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)', 'function maxWithdraw(address owner) view returns (uint256)',
  'function deposit(uint256 assets, address receiver, uint256 minShares, uint16 referral) returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner, uint256 maxShares) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address owner, uint256 minAssets) returns (uint256)',
]);

const lessSlippage = (x, bps) => x * BigInt(10000 - bps) / 10000n;
const moreSlippage = (x, bps) => (x * BigInt(10000 + bps) + 9999n) / 10000n;

async function read(chain, target, iface, fn, args) {
  const [r] = await multicall(chain, [{ target, iface, fn, args }]);
  if (!r.ok) throw new venues.YieldRefused(`${fn} couldn't be read from ${target} on ${chain}`, 503);
  return r.value[0];
}

/** A dollar amount → the asset's smallest units. Stablecoins are a dollar; WETH at Aave's oracle price. */
async function usdToUnits(chain, asset, amountUsd) {
  const t = venues.tokenOf(chain, asset);
  if (t.stable) return ethers.parseUnits(Number(amountUsd).toFixed(t.decimals), t.decimals);
  const price = await rates.priceUsd(chain, asset);
  return ethers.parseUnits((Number(amountUsd) / price).toFixed(12), t.decimals);
}

/** What the wallet holds in a venue, in the asset's units (Spark: what its shares are worth). */
async function held(v, asset, wallet) {
  const t = venues.positionToken(v, asset);
  const bal = BigInt(await read(v.chain, t, ERC20, 'balanceOf', [wallet]));
  if (v.kind !== 'spark' || bal === 0n) return { units: bal, shares: bal };
  return { units: BigInt(await read(v.chain, v.vault, SPARK, 'previewRedeem', [bal])), shares: bal };
}

/** The deposit call into a venue on the wallet's behalf, and the contract to approve. */
async function depositCall({ v, asset, wallet, amount, maxSlippageBps = DEFAULT_SLIPPAGE_BPS }) {
  const token = venues.tokenOf(v.chain, asset);
  if (v.kind === 'aave') return { to: v.pool, spender: v.pool, data: AAVE.encodeFunctionData('supply', [token.address, amount, wallet, 0]) };
  if (v.kind === 'comet') return { to: v.comet, spender: v.comet, data: COMET.encodeFunctionData('supply', [token.address, amount]) };
  if (v.kind === 'spark') {
    if (String(await read(v.chain, v.vault, SPARK, 'asset', [])).toLowerCase() !== token.address) throw new venues.YieldRefused(`The ${v.name} vault on ${v.chain} doesn't take ${asset}: refusing.`);
    const minShares = lessSlippage(BigInt(await read(v.chain, v.vault, SPARK, 'previewDeposit', [amount])), maxSlippageBps);
    return { to: v.vault, spender: v.vault, data: SPARK.encodeFunctionData('deposit', [amount, wallet, minShares, 0]), minShares };
  }
  throw new venues.YieldRefused(`Deposits into ${v.name} aren't supported.`);
}

/**
 * The withdrawal back to the wallet: `want` units, or everything when null.
 * `amountOut` is what arrives (ERC-4626 previews round down, so at least
 * that); `minReceived` is the slippage bound the call itself enforces.
 */
async function withdrawCall({ v, asset, wallet, want, maxSlippageBps = DEFAULT_SLIPPAGE_BPS }) {
  const token = venues.tokenOf(v.chain, asset);
  const fmt = u => ethers.formatUnits(u, token.decimals);
  const h = await held(v, asset, wallet);
  if (h.units === 0n) throw new venues.YieldRefused(`There is no ${asset} in ${v.name} on ${venues.CHAINS[v.chain].label} to withdraw.`);
  if (want !== null && want > h.units) throw new venues.YieldRefused(`${v.name} holds ${fmt(h.units)} ${asset} for this wallet on ${venues.CHAINS[v.chain].label}, less than ${fmt(want)}.`);
  if (v.kind === 'aave') {
    // type(uint256).max withdraws the whole balance, interest to the last second.
    return { to: v.pool, data: AAVE.encodeFunctionData('withdraw', [token.address, want ?? ethers.MaxUint256, wallet]), amountOut: want ?? h.units, minReceived: want ?? h.units };
  }
  if (v.kind === 'comet') {
    // Never more than the balance: withdrawing more from Comet borrows the rest.
    return { to: v.comet, data: COMET.encodeFunctionData('withdraw', [token.address, want ?? h.units]), amountOut: want ?? h.units, minReceived: want ?? h.units };
  }
  if (v.kind === 'spark') {
    if (want === null) {
      const minAssets = lessSlippage(h.units, maxSlippageBps);
      return { to: v.vault, data: SPARK.encodeFunctionData('redeem', [h.shares, wallet, wallet, minAssets]), amountOut: h.units, minReceived: minAssets };
    }
    const max = BigInt(await read(v.chain, v.vault, SPARK, 'maxWithdraw', [wallet]));
    if (want > max) throw new venues.YieldRefused(`Spark can pay out ${fmt(max)} USDC to this wallet on ${venues.CHAINS[v.chain].label} now, less than ${fmt(want)}.`);
    const maxShares = moreSlippage(BigInt(await read(v.chain, v.vault, SPARK, 'previewWithdraw', [want])), maxSlippageBps);
    return { to: v.vault, data: SPARK.encodeFunctionData('withdraw', [want, wallet, wallet, maxShares]), amountOut: want, minReceived: want };
  }
  throw new venues.YieldRefused(`Withdrawing from ${v.name} isn't supported.`);
}

module.exports = { DEFAULT_SLIPPAGE_BPS, GAS, ERC20, AAVE, COMET, SPARK, lessSlippage, moreSlippage, usdToUnits, held, depositCall, withdrawCall, read };

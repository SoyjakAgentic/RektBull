/**
 * How the Trade Router reaches an exchange for one swap: which contract it
 * calls, which it approves, and the calldata.
 *
 * - mock (Base Sepolia): the test exchange deployed with the router; it pays
 *   at a rate taken from the router's own price feeds, so test trades land
 *   at the reference price.
 * - 0x (mainnet, after the audit): a 0x AllowanceHolder quote with the router
 *   as taker, so the output comes back to the router, which checks it and
 *   sends it to the user. Not usable until the router is deployed on mainnet.
 *
 * Whatever this returns, the router decides: it pays out only what came back
 * to it, only to the user, and only if it's near the reference price.
 */
const { ethers } = require('ethers');
const { evmRpc } = require('../providers/rpc');

const ROUTER = new ethers.Interface([
  'function valueUsd(address token, uint256 amount) view returns (uint256)',
  'function amountForUsd(address token, uint256 usd) view returns (uint256)',
  'function FEE_BPS() view returns (uint16)',
]);
const MOCK = new ethers.Interface(['function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 rate, address to)']);

async function view(net, fn, args) {
  const raw = await evmRpc(net.name, 'eth_call', [{ to: net.router, data: ROUTER.encodeFunctionData(fn, args) }, 'latest']);
  return ROUTER.decodeFunctionResult(fn, raw)[0];
}

/** The amount after the router's fee, as the router computes it. */
const afterFee = (amountIn, feeBps = 100n) => amountIn - amountIn * feeBps / 10000n;

async function venueCall(net, { tokenIn, tokenOut, amountIn }) {
  const toTrade = afterFee(amountIn, BigInt(await view(net, 'FEE_BPS', [])));
  if (net.venue.type === 'mock') {
    const usd = await view(net, 'valueUsd', [tokenIn, toTrade]);
    const out = await view(net, 'amountForUsd', [tokenOut, usd]);
    const rate = toTrade === 0n ? 0n : out * 10n ** 18n / toTrade;
    return {
      venue: net.venue.address, spender: net.venue.address,
      venueCalldata: MOCK.encodeFunctionData('swap', [tokenIn, tokenOut, toTrade, rate, net.router]),
      expectedOut: out,
    };
  }
  if (net.venue.type === '0x') {
    const zeroex = require('./zeroex');
    const q = await zeroex.quote({ chainId: net.chainId, sellToken: tokenIn, buyToken: tokenOut, sellAmount: toTrade, taker: net.router, slippageBps: 100 });
    const ah = net.venue.address.toLowerCase();
    if (String(q.transaction.to).toLowerCase() !== ah) throw new Error(`0x returned a transaction to ${q.transaction.to}, not its AllowanceHolder`);
    return { venue: ah, spender: ah, venueCalldata: q.transaction.data, expectedOut: q.buyAmount };
  }
  throw new Error(`unknown venue type ${net.venue.type}`);
}

module.exports = { venueCall, view, afterFee };

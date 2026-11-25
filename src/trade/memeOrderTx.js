/**
 * The Meme Router's orders and calls (contracts/contracts/RektBullMemeRouter.sol,
 * docs/MEME_ROUTER.md), built from plain inputs: the EIP-712 order the user's
 * wallet signs, and the calls the user's wallet or RektBull's executor sends
 * (fill, cancel, cancelAll, the router's approval, wrapping the native coin).
 * Nothing here signs or sends; memeOrders.js gathers the inputs.
 * contracts/test/memeOrdersService.test.js runs these against the contract
 * itself, so a layout that drifts fails CI.
 */
const { ethers } = require('ethers');

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ORDER_FIELDS = [
  ['account', 'address'], ['executor', 'address'], ['tokenIn', 'address'], ['tokenOut', 'address'],
  ['amountIn', 'uint256'], ['minAmountOut', 'uint256'], ['validAfter', 'uint64'], ['validUntil', 'uint64'],
  ['epoch', 'uint64'], ['salt', 'uint256'],
];
const TYPES = { Order: ORDER_FIELDS.map(([name, type]) => ({ name, type })) };
const ORDER_TUPLE = `(${ORDER_FIELDS.map(([n, t]) => `${t} ${n}`).join(',')})`;
const ROUTER = new ethers.Interface([
  `function fill(${ORDER_TUPLE} o, bytes signature, (uint256 amountIn,address venue,address spender,bytes venueCalldata,bool unwrapIn,uint256 minAmountOut) f) returns (uint256 amountOut)`,
  `function cancel(${ORDER_TUPLE} o)`,
  'function cancelAll()',
  `function hashOrder(${ORDER_TUPLE} o) view returns (bytes32)`,
  'function epochOf(address) view returns (uint64)',
  'function cancelled(bytes32) view returns (bool)',
  'function filled(bytes32) view returns (uint256)',
  'function FEE_BPS() view returns (uint16)',
  'function FEE_WALLET() view returns (address)',
  'function WRAPPED_NATIVE() view returns (address)',
  'function isVenue(address) view returns (bool)',
  'function isBase(address) view returns (bool)',
  'event Filled(bytes32 indexed orderHash, address indexed account, address tokenIn, address tokenOut, uint256 amountIn, uint256 fee, bool feeOnOutput, uint256 amountOut)',
  'error BelowLimit(uint256 amountOut, uint256 minimum)',
  'error NotExecutor()', 'error NotYetValid()', 'error Expired()', 'error OrderCancelled()', 'error BadSignature()',
  'error Overfilled(uint256 filled, uint256 amountIn)', 'error NotAllowed()', 'error VenueFailed(bytes reason)', 'error NativeTransferFailed()',
]);
const ERC20 = new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
]);
const WRAPPED = new ethers.Interface(['function deposit() payable']);

const domain = (chainId, router) => ({ name: 'RektBull Meme Router', version: '1', chainId: Number(chainId), verifyingContract: ethers.getAddress(router) });

/** An order with every field in the contract's types (numbers as bigints, addresses checksummed). */
function order({ account, executor, tokenIn, tokenOut, amountIn, minAmountOut, validAfter = 0, validUntil, epoch, salt }) {
  return {
    account: ethers.getAddress(account), executor: ethers.getAddress(executor), tokenIn: ethers.getAddress(tokenIn), tokenOut: ethers.getAddress(tokenOut),
    amountIn: BigInt(amountIn), minAmountOut: BigInt(minAmountOut), validAfter: BigInt(validAfter), validUntil: BigInt(validUntil), epoch: BigInt(epoch), salt: BigInt(salt),
  };
}
/** The order as stored and sent to the page (numbers as decimal strings), and back. */
const toJson = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
const fromJson = j => order(j);

/** What the wallet signs (eth_signTypedData_v4's JSON: EIP712Domain included). */
function typedData(chainId, router, o) {
  return {
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...TYPES },
    primaryType: 'Order', domain: domain(chainId, router), message: toJson(o),
  };
}
/** The order's hash, as the router's hashOrder computes it. */
const hash = (chainId, router, o) => ethers.TypedDataEncoder.hash(domain(chainId, router), TYPES, o);
/** Who signed it (an EOA); a contract wallet is checked through EIP-1271 by the caller. */
const signer = (chainId, router, o, signature) => ethers.verifyTypedData(domain(chainId, router), TYPES, o, signature);

/** The executor's fill: { to, data }. `fill` is { amountIn, venue, spender, venueCalldata, unwrapIn, minAmountOut }. */
function fillCall(router, o, signature, f) {
  return { to: ethers.getAddress(router), data: ROUTER.encodeFunctionData('fill', [o, signature, [BigInt(f.amountIn), f.venue, f.spender, f.venueCalldata, !!f.unwrapIn, BigInt(f.minAmountOut || 0)]]) };
}
/** The user's own calls: cancel one order, cancel every order, approve the router, wrap the native coin. */
const cancelCall = (router, o) => ({ to: ethers.getAddress(router), data: ROUTER.encodeFunctionData('cancel', [o]), value: '0x0' });
const cancelAllCall = router => ({ to: ethers.getAddress(router), data: ROUTER.encodeFunctionData('cancelAll', []), value: '0x0' });
const approveCall = (token, router, amount) => ({ to: ethers.getAddress(token), data: ERC20.encodeFunctionData('approve', [ethers.getAddress(router), BigInt(amount)]), value: '0x0' });
const wrapCall = (wrapped, amount) => ({ to: ethers.getAddress(wrapped), data: WRAPPED.encodeFunctionData('deposit', []), value: ethers.toBeHex(BigInt(amount)) });

/** The router's Filled events for `account` in a receipt's logs. */
function filledEvents(logs, router, account = null) {
  const out = [];
  for (const l of logs || []) {
    if (String(l.address).toLowerCase() !== String(router).toLowerCase()) continue;
    let e;
    try { e = ROUTER.parseLog(l); } catch { continue; }
    if (e?.name !== 'Filled') continue;
    if (account && e.args.account.toLowerCase() !== String(account).toLowerCase()) continue;
    out.push({ orderHash: e.args.orderHash, account: e.args.account, amountIn: e.args.amountIn, fee: e.args.fee, feeOnOutput: e.args.feeOnOutput, amountOut: e.args.amountOut });
  }
  return out;
}

/** The router's error in a revert's data, as "Name(args)", or null. */
function routerError(data) {
  const hex = String(data || '').match(/0x[0-9a-f]{8,}/i)?.[0];
  if (!hex) return null;
  try { const e = ROUTER.parseError(hex); return e ? { name: e.name, args: e.args } : null; } catch { return null; }
}

/** The user's price for part of an order: ceil(minAmountOut × part / amountIn), as the router works it out. */
const minimumFor = (minAmountOut, part, amountIn) => (BigInt(minAmountOut) * BigInt(part) + BigInt(amountIn) - 1n) / BigInt(amountIn);
/** What the venue may use of a fill whose fee is on the input: the router keeps FEE_BPS of it back. */
const toTrade = (received, feeBps, feeOnOutput) => (feeOnOutput ? BigInt(received) : BigInt(received) - BigInt(received) * BigInt(feeBps) / 10000n);

module.exports = { NATIVE, TYPES, ROUTER, ERC20, domain, order, toJson, fromJson, typedData, hash, signer, fillCall, cancelCall, cancelAllCall, approveCall, wrapCall, filledEvents, routerError, minimumFor, toTrade };

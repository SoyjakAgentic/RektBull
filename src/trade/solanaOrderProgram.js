/**
 * The Solana order program's client (solana/programs/rektbull-orders,
 * docs/SOLANA_ORDERS.md): its addresses, its instructions as bytes, and its
 * order accounts read back. Nothing here signs or sends; the order service
 * (solanaOrders.js) builds transactions from these.
 *
 * The layouts are the program's own (Anchor 0.32, Borsh): an instruction is
 * the first 8 bytes of sha256("global:<name>") then its arguments; an account
 * the first 8 of sha256("account:<Name>") then its fields; an event the first
 * 8 of sha256("event:<Name>"). solana/programs/rektbull-orders/tests/js_client.rs
 * runs transactions built here against the compiled program, so a layout that
 * drifts fails CI.
 */
const crypto = require('crypto');
const k = require('@solana/kit');

const P = {
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  compute: 'ComputeBudget111111111111111111111111111111',
  pumpFun: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpAmm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
};
const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = new Set([P.token, P.token2022]);
/** The order account's size: 8 + Order::INIT_SPACE (4 keys, a bool, 6 u64/i64, a u8). */
const ORDER_SPACE = 8 + 32 * 4 + 1 + 8 * 6 + 1;

const sha = s => crypto.createHash('sha256').update(s).digest();
const ix8 = name => sha(`global:${name}`).subarray(0, 8);
const DISC = {
  placeOrder: ix8('place_order'),
  cancelOrder: ix8('cancel_order'),
  fill: ix8('fill'),
  closeVolume: ix8('close_volume_account'),
  initVolume: ix8('init_user_volume_accumulator'), // pump.fun's and PumpSwap's own instruction
  order: sha('account:Order').subarray(0, 8),
  filled: sha('event:Filled').subarray(0, 8),
};

const enc = () => k.getAddressEncoder();
const bytesOf = a => Buffer.from(enc().encode(k.address(a)));
const b58 = bytes => k.getBase58Decoder().decode(Uint8Array.from(bytes));
const u64le = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64le = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };

async function pda(program, seeds) {
  const [addr] = await k.getProgramDerivedAddress({ programAddress: k.address(program), seeds });
  return addr;
}

/** The program's addresses for one owner: their transit, and the program's delegate. */
const delegateOf = program => pda(program, [Buffer.from('delegate')]);
const transitOf = (program, owner) => pda(program, [Buffer.from('transit'), bytesOf(owner)]);
const orderOf = (program, owner, nonce) => pda(program, [Buffer.from('order'), bytesOf(owner), u64le(nonce)]);
/** pump.fun's and PumpSwap's per-trader volume account, and each one's Anchor event authority. */
const volumeOf = (venue, user) => pda(venue, [Buffer.from('user_volume_accumulator'), bytesOf(user)]);
const eventAuthorityOf = venue => pda(venue, [Buffer.from('__event_authority')]);
/** pump.fun's bonding curve for a mint: present while (and after) the coin is on pump.fun's curve. */
const bondingCurveOf = mint => pda(P.pumpFun, [Buffer.from('bonding-curve'), bytesOf(mint)]);
/** An associated token account. */
const ataOf = (owner, tokenProgram, mint) => pda(P.ata, [bytesOf(owner), bytesOf(tokenProgram), bytesOf(mint)]);

/* ── Instructions: { programAddress, accounts: [{ address, role }], data } (@solana/kit's shape) ── */

const R = k.AccountRole;
const w = a => ({ address: k.address(a), role: R.WRITABLE });
const r = a => ({ address: k.address(a), role: R.READONLY });
const ws = a => ({ address: k.address(a), role: R.WRITABLE_SIGNER });
const ix = (program, accounts, data) => ({ programAddress: k.address(program), accounts, data: new Uint8Array(data) });

/**
 * place_order(nonce, OrderParams). The owner signs and pays the order
 * account's rent (returned when it's filled or cancelled).
 */
async function placeOrder({ program, owner, nonce, executor, inputMint, outputMint, outputNative, amountIn, minAmountOut, validAfter = 0, validUntil }) {
  const order = await orderOf(program, owner, nonce);
  const data = Buffer.concat([
    DISC.placeOrder, u64le(nonce),
    bytesOf(executor), bytesOf(inputMint), bytesOf(outputMint), Buffer.from([outputNative ? 1 : 0]),
    u64le(amountIn), u64le(minAmountOut), i64le(validAfter), i64le(validUntil),
  ]);
  return { order, instruction: ix(program, [ws(owner), w(order), r(P.system)], data) };
}

/** cancel_order: the owner closes their order; its rent comes back to them. */
const cancelOrder = ({ program, owner, order }) => ix(program, [ws(owner), w(order)], DISC.cancelOrder);

/**
 * fill(amount_in, unwrap_in, venue_data), signed by the executor. Accounts in
 * the program's order; an optional account left out is passed as the
 * program's own address (Anchor's "None"). The venue's own accounts follow,
 * none of them a signer: the program signs for transit itself.
 */
function fill({ program, executor, order, owner, delegate, transit, source, inputMint, transitIn, inputTokenProgram,
  outputMint = null, transitOut = null, ownerOut = null, outputTokenProgram = null, feeWallet, feeIn = null, feeOut = null,
  venue, amountIn, unwrapIn = false, venueData, venueAccounts }) {
  const opt = (a, role) => (a ? { address: k.address(a), role } : r(program));
  const accounts = [
    ws(executor), w(order), w(owner), r(delegate), w(transit), w(source), r(inputMint), w(transitIn), r(inputTokenProgram),
    opt(outputMint, R.READONLY), opt(transitOut, R.WRITABLE), opt(ownerOut, R.WRITABLE), opt(outputTokenProgram, R.READONLY),
    w(feeWallet), opt(feeIn, R.WRITABLE), opt(feeOut, R.WRITABLE), r(venue), r(P.system),
    ...venueAccounts.map(a => ({ address: k.address(a.address), role: a.writable ? R.WRITABLE : R.READONLY })),
  ];
  const vd = Buffer.from(venueData);
  const len = Buffer.alloc(4); len.writeUInt32LE(vd.length);
  return ix(program, accounts, Buffer.concat([DISC.fill, u64le(amountIn), Buffer.from([unwrapIn ? 1 : 0]), len, vd]));
}

/** SPL ApproveChecked (13): the owner lets `delegate` move up to `amount` of `mint` from `source`. */
function approveChecked({ tokenProgram, source, mint, delegate, owner, amount, decimals }) {
  return ix(tokenProgram, [w(source), r(mint), r(delegate), { address: k.address(owner), role: R.READONLY_SIGNER }], Buffer.concat([Buffer.from([13]), u64le(amount), Buffer.from([decimals])]));
}
/** SPL Revoke (5): the owner takes back the approval on `source`. */
const revoke = ({ tokenProgram, source, owner }) => ix(tokenProgram, [w(source), { address: k.address(owner), role: R.READONLY_SIGNER }], [5]);

/** The Associated Token Account program's create_idempotent (1), paid by `payer`. */
function createAtaIdempotent({ payer, ata, owner, mint, tokenProgram }) {
  return ix(P.ata, [ws(payer), w(ata), r(owner), r(mint), r(P.system), r(tokenProgram)], [1]);
}

/** pump.fun's or PumpSwap's init_user_volume_accumulator for `user` (here, the owner's transit), paid by `payer`. */
async function initVolume({ venue, payer, user }) {
  return ix(venue, [ws(payer), r(user), w(await volumeOf(venue, user)), r(P.system), r(await eventAuthorityOf(venue)), r(venue)], DISC.initVolume);
}

const cuLimit = units => ix(P.compute, [], [2, ...Buffer.from(Uint32Array.of(units).buffer)]);
function cuPrice(microLamports) {
  const b = Buffer.alloc(9); b[0] = 3; b.writeBigUInt64LE(BigInt(microLamports), 1);
  return ix(P.compute, [], b);
}

/* ── Reading back ── */

/** An order account's fields from its data (base64 or bytes); null when it isn't one. */
function decodeOrder(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data, typeof data === 'string' ? 'base64' : undefined);
  if (b.length < ORDER_SPACE || !b.subarray(0, 8).equals(DISC.order)) return null;
  let o = 8;
  const key = () => { const v = b58(b.subarray(o, o + 32)); o += 32; return v; };
  const u = () => { const v = b.readBigUInt64LE(o); o += 8; return v; };
  const i = () => { const v = b.readBigInt64LE(o); o += 8; return v; };
  const owner = key(); const executor = key(); const inputMint = key(); const outputMint = key();
  const outputNative = b[o++] === 1;
  const amountIn = u(); const minAmountOut = u(); const filledIn = u(); const validAfter = i(); const validUntil = i(); const nonce = u();
  return { owner, executor, inputMint, outputMint, outputNative, amountIn, minAmountOut, filledIn, validAfter, validUntil, nonce, bump: b[o] };
}

/** The program's Filled events in a transaction's logs ("Program data: <base64>"). */
function filledEvents(logs) {
  const out = [];
  for (const l of logs || []) {
    const m = /^Program data: (.+)$/.exec(l);
    if (!m) continue;
    const b = Buffer.from(m[1], 'base64');
    if (b.length < 8 + 64 + 32 || !b.subarray(0, 8).equals(DISC.filled)) continue;
    out.push({ order: b58(b.subarray(8, 40)), owner: b58(b.subarray(40, 72)), amountIn: b.readBigUInt64LE(72), fee: b.readBigUInt64LE(80), delivered: b.readBigUInt64LE(88), minimum: b.readBigUInt64LE(96) });
  }
  return out;
}

/** The user's price for part of an order: ceil(min_amount_out × part / amount_in), as the program works it out. */
const minimumFor = (minAmountOut, part, amountIn) => (BigInt(minAmountOut) * BigInt(part) + BigInt(amountIn) - 1n) / BigInt(amountIn);
/** RektBull's fee on an output (rounded down): what the program takes from a sale for SOL. */
const feeOf = (amount, bps = 100n) => BigInt(amount) * BigInt(bps) / 10000n;

module.exports = {
  P, WSOL, TOKEN_PROGRAMS, ORDER_SPACE, DISC,
  delegateOf, transitOf, orderOf, volumeOf, eventAuthorityOf, bondingCurveOf, ataOf,
  placeOrder, cancelOrder, fill, approveChecked, revoke, createAtaIdempotent, initVolume, cuLimit, cuPrice,
  decodeOrder, filledEvents, minimumFor, feeOf,
};

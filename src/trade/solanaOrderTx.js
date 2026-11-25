/**
 * The Solana order service's transactions, built from plain inputs (no
 * database, no network): what the user signs to place or cancel an order,
 * and what the executor signs to fill one. solanaOrders.js gathers the inputs;
 * scripts/solana-order-fixtures.js builds the same transactions for the
 * program's own test chain (tests/js_client.rs), so what runs in CI is this
 * code, not a copy of it.
 */
const k = require('@solana/kit');
const op = require('./solanaOrderProgram');

const MAX_TX_BYTES = 1232; // Solana's packet limit

/**
 * One version-0 transaction, unsigned: { tx, messageBytes, transaction (base64 wire), bytes }.
 * `tables` maps a lookup table's address to the addresses it holds.
 */
function compile({ payer, instructions, blockhash, lastValidBlockHeight, tables = {} }) {
  const lookups = Object.fromEntries(Object.entries(tables).map(([t, list]) => [k.address(t), list.map(x => k.address(x))]));
  const msg = k.pipe(
    k.createTransactionMessage({ version: 0 }),
    m => k.setTransactionMessageFeePayer(k.address(payer), m),
    m => k.setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) }, m),
    m => k.appendTransactionMessageInstructions(instructions, m),
    m => k.compressTransactionMessageUsingAddressLookupTables(m, lookups),
  );
  const tx = k.compileTransaction(msg);
  const transaction = k.getBase64EncodedWireTransaction(tx);
  return { tx, messageBytes: Buffer.from(tx.messageBytes), transaction, bytes: Buffer.from(transaction, 'base64').length };
}

/** The wire transaction (base64) with `address`'s signature in place. */
function withSignature(tx, address, signature) {
  const signed = { ...tx, signatures: { ...tx.signatures, [k.address(address)]: Uint8Array.from(signature) } };
  return k.getBase64EncodedWireTransaction(signed);
}

/**
 * What the user signs to place a sell order for SOL (a stop-loss, a
 * take-profit or a Meme Watch exit), in one transaction:
 *   - the order account (place_order), naming the executor and the user's floor;
 *   - an SPL approval of the program's delegate on the token account it sells
 *     from, for `approveAmount` (this order plus the user's other open orders
 *     on the same account: an approval replaces the one before it);
 *   - once per user and exchange, pump.fun's and PumpSwap's volume account for
 *     their transit (`volumeVenues`), paid by them: without it the exchange
 *     would try to create it during a fill, from transit, which holds nothing.
 */
async function placeInstructions({ program, owner, executor, nonce, token, tokenProgram, decimals, source, approveAmount, amountIn, minOut, validUntil, volumeVenues = [], units = null, orders = null }) {
  const [delegate, transit] = await Promise.all([op.delegateOf(program), op.transitOf(program, owner)]);
  // Several orders on the same coin (take-profits in steps): one place_order each, and one approval for all of them.
  const legs = orders || [{ nonce, amountIn, minOut }];
  const placed = await Promise.all(legs.map(l => op.placeOrder({ program, owner, nonce: l.nonce, executor, inputMint: token, outputMint: op.WSOL, outputNative: true, amountIn: l.amountIn, minAmountOut: l.minOut, validUntil })));
  const instructions = [
    ...(units ? [op.cuLimit(units)] : []),
    ...await Promise.all(volumeVenues.map(venue => op.initVolume({ venue, payer: owner, user: transit }))),
    ...placed.map(p => p.instruction),
    op.approveChecked({ tokenProgram, source, mint: token, delegate, owner, amount: approveAmount, decimals }),
  ];
  return { instructions, order: placed[0].order, orders: placed.map(p => p.order), delegate, transit };
}

/**
 * What the user signs to place a limit buy (a coin bought with SOL), in one
 * transaction:
 *   - their wrapped-SOL account (created when missing), with `wrapLamports`
 *     of their SOL moved into it: the program's delegate can only be approved
 *     on a token account, and wrapped SOL is one;
 *   - their token account for the coin (created when missing): the program
 *     delivers the coin only there;
 *   - pump.fun's and PumpSwap's volume accounts for their transit, once;
 *   - the order (place_order), the user's limit as the least they'll take;
 *   - the approval of the delegate on the wrapped-SOL account, for this order
 *     plus what's left of their other open buys (`approveAmount`).
 */
async function placeBuyInstructions({ program, owner, executor, nonce, token, tokenProgram, amountIn, minOut, validUntil, wrapLamports, approveAmount, volumeVenues = [], units = null }) {
  const [delegate, transit] = await Promise.all([op.delegateOf(program), op.transitOf(program, owner)]);
  const [wsol, ownerOut] = await Promise.all([op.ataOf(owner, op.P.token, op.WSOL), op.ataOf(owner, tokenProgram, token)]);
  const placed = await op.placeOrder({ program, owner, nonce, executor, inputMint: op.WSOL, outputMint: token, outputNative: false, amountIn, minAmountOut: minOut, validUntil });
  const instructions = [
    ...(units ? [op.cuLimit(units)] : []),
    op.createAtaIdempotent({ payer: owner, ata: wsol, owner, mint: op.WSOL, tokenProgram: op.P.token }),
    ...(BigInt(wrapLamports) > 0n ? [op.transfer({ from: owner, to: wsol, lamports: wrapLamports }), op.syncNative(wsol)] : []),
    op.createAtaIdempotent({ payer: owner, ata: ownerOut, owner, mint: token, tokenProgram }),
    ...await Promise.all(volumeVenues.map(venue => op.initVolume({ venue, payer: owner, user: transit }))),
    placed.instruction,
    op.approveChecked({ tokenProgram: op.P.token, source: wsol, mint: op.WSOL, delegate, owner, amount: approveAmount, decimals: 9 }),
  ];
  return { instructions, order: placed.order, delegate, transit, wsol, ownerOut };
}

/**
 * What the user signs to cancel: the order closed (its rent back), and, when
 * it was the last on that account, the approval revoked. For a buy, also when
 * it was the last, `unwrap` closes their wrapped-SOL account back into SOL.
 */
function cancelInstructions({ program, owner, order, revokeSource = null, tokenProgram = null, unwrap = null }) {
  return [
    op.cancelOrder({ program, owner, order }),
    ...(revokeSource ? [op.revoke({ tokenProgram, source: revokeSource, owner })] : []),
    ...(unwrap ? [op.closeAccount({ account: unwrap, to: owner, owner })] : []),
  ];
}

/**
 * What the executor signs to fill `amountIn` of an order through an
 * exchange's swap (`swap`: { programId, accounts: [{ pubkey, isSigner,
 * isWritable }], data }, with transit as the trader, as Jupiter's /build gives
 * it for transit as the taker).
 *   - a sale for SOL (`side` 'sell'): transit's account for the coin, and its
 *     wrapped-SOL account (the exchange pays wrapped SOL; the program unwraps
 *     it for the user);
 *   - a buy with SOL ('buy'): transit's wrapped-SOL account (what the
 *     exchange spends), its account for the coin, and the fee wallet's
 *     wrapped-SOL account (the 1% is taken in wrapped SOL, from what the
 *     exchange didn't use); the coin goes only to the user's own account for it;
 *   - each opened by the executor when missing: the program closes transit's
 *     after the fill and sends their rent back to the executor;
 *   - the fill itself. The swap's accounts go to the program unsigned: the
 *     program signs for transit, and nothing else.
 */
async function fillInstructions({ program, executor, owner, order, token, tokenProgram, source, feeWallet, swap, amountIn, units, microLamports = 0, wrappedOut = true, side = 'sell', unwrapIn = false }) {
  const [delegate, transit] = await Promise.all([op.delegateOf(program), op.transitOf(program, owner)]);
  const [transitCoin, transitWsol] = await Promise.all([op.ataOf(transit, tokenProgram, token), op.ataOf(transit, op.P.token, op.WSOL)]);
  const venueAccounts = swap.accounts.map(a => ({ address: a.pubkey, writable: !!a.isWritable }));
  const data = typeof swap.data === 'string' ? Buffer.from(swap.data, 'base64') : Buffer.from(swap.data);
  const budget = [...(units ? [op.cuLimit(units)] : []), ...(microLamports > 0 ? [op.cuPrice(microLamports)] : [])];
  const open = (ata, mint, tp, who = transit) => op.createAtaIdempotent({ payer: executor, ata, owner: who, mint, tokenProgram: tp });
  if (side === 'buy') {
    // Through Jupiter, the 1% is taken in wrapped SOL (the fee wallet's account); straight on pump.fun's curve
    // (`unwrapIn`), the program unwraps the SOL for the curve and takes the 1% in SOL.
    const [ownerOut, feeIn] = await Promise.all([op.ataOf(owner, tokenProgram, token), unwrapIn ? null : op.ataOf(feeWallet, op.P.token, op.WSOL)]);
    const instructions = [
      ...budget, open(transitWsol, op.WSOL, op.P.token), open(transitCoin, token, tokenProgram), ...(feeIn ? [open(feeIn, op.WSOL, op.P.token, feeWallet)] : []),
      op.fill({
        program, executor, order, owner, delegate, transit, source, inputMint: op.WSOL, transitIn: transitWsol, inputTokenProgram: op.P.token,
        outputMint: token, transitOut: transitCoin, ownerOut, outputTokenProgram: tokenProgram,
        feeWallet, feeIn, venue: swap.programId, amountIn, unwrapIn, venueData: data, venueAccounts,
      }),
    ];
    return { instructions, transit, transitIn: transitWsol, transitOut: transitCoin, ownerOut, feeIn, delegate };
  }
  const instructions = [
    ...budget, open(transitCoin, token, tokenProgram), ...(wrappedOut ? [open(transitWsol, op.WSOL, op.P.token)] : []),
    op.fill({
      program, executor, order, owner, delegate, transit, source, inputMint: token, transitIn: transitCoin, inputTokenProgram: tokenProgram,
      transitOut: wrappedOut ? transitWsol : null, outputTokenProgram: wrappedOut ? op.P.token : null,
      feeWallet, venue: swap.programId, amountIn, unwrapIn: false, venueData: data, venueAccounts,
    }),
  ];
  return { instructions, transit, transitIn: transitCoin, transitWsol, delegate };
}

/** How much of a buy's SOL goes to the exchange: what's left after room for the 1%, which the program takes from what it didn't use. */
const buySwapAmount = amountIn => BigInt(amountIn) * 9900n / 10000n;

module.exports = { compile, withSignature, placeInstructions, placeBuyInstructions, cancelInstructions, fillInstructions, buySwapAmount, MAX_TX_BYTES };

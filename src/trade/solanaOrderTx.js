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
async function placeInstructions({ program, owner, executor, nonce, token, tokenProgram, decimals, source, approveAmount, amountIn, minOut, validUntil, volumeVenues = [], units = null }) {
  const [delegate, transit] = await Promise.all([op.delegateOf(program), op.transitOf(program, owner)]);
  const placed = await op.placeOrder({ program, owner, nonce, executor, inputMint: token, outputMint: op.WSOL, outputNative: true, amountIn, minAmountOut: minOut, validUntil });
  const instructions = [
    ...(units ? [op.cuLimit(units)] : []),
    ...await Promise.all(volumeVenues.map(venue => op.initVolume({ venue, payer: owner, user: transit }))),
    placed.instruction,
    op.approveChecked({ tokenProgram, source, mint: token, delegate, owner, amount: approveAmount, decimals }),
  ];
  return { instructions, order: placed.order, delegate, transit };
}

/** What the user signs to cancel: the order closed (its rent back), and, when it was the last on that account, the approval revoked. */
function cancelInstructions({ program, owner, order, revokeSource = null, tokenProgram = null }) {
  return [op.cancelOrder({ program, owner, order }), ...(revokeSource ? [op.revoke({ tokenProgram, source: revokeSource, owner })] : [])];
}

/**
 * What the executor signs to fill `amountIn` of a sell-for-SOL order through
 * an exchange's swap (`swap`: { programId, accounts: [{ pubkey, isSigner,
 * isWritable }], data }, with transit as the trader, as Jupiter's /build gives
 * it for transit as the taker).
 *   - transit's token account for the coin, and its wrapped-SOL account (the
 *     exchange pays wrapped SOL; the program unwraps it for the user), opened
 *     by the executor when missing: the program closes them after the fill and
 *     sends their rent back to the executor;
 *   - the fill itself. The swap's accounts go to the program unsigned: the
 *     program signs for transit, and nothing else.
 */
async function fillInstructions({ program, executor, owner, order, token, tokenProgram, source, feeWallet, swap, amountIn, units, microLamports = 0, wrappedOut = true }) {
  const [delegate, transit] = await Promise.all([op.delegateOf(program), op.transitOf(program, owner)]);
  const [transitIn, transitWsol] = await Promise.all([op.ataOf(transit, tokenProgram, token), op.ataOf(transit, op.P.token, op.WSOL)]);
  const venueAccounts = swap.accounts.map(a => ({ address: a.pubkey, writable: !!a.isWritable }));
  const data = typeof swap.data === 'string' ? Buffer.from(swap.data, 'base64') : Buffer.from(swap.data);
  const instructions = [
    ...(units ? [op.cuLimit(units)] : []),
    ...(microLamports > 0 ? [op.cuPrice(microLamports)] : []),
    op.createAtaIdempotent({ payer: executor, ata: transitIn, owner: transit, mint: token, tokenProgram }),
    ...(wrappedOut ? [op.createAtaIdempotent({ payer: executor, ata: transitWsol, owner: transit, mint: op.WSOL, tokenProgram: op.P.token })] : []),
    op.fill({
      program, executor, order, owner, delegate, transit, source, inputMint: token, transitIn, inputTokenProgram: tokenProgram,
      transitOut: wrappedOut ? transitWsol : null, outputTokenProgram: wrappedOut ? op.P.token : null,
      feeWallet, venue: swap.programId, amountIn, unwrapIn: false, venueData: data, venueAccounts,
    }),
  ];
  return { instructions, transit, transitIn, transitWsol, delegate };
}

module.exports = { compile, withSignature, placeInstructions, cancelInstructions, fillInstructions, MAX_TX_BYTES };

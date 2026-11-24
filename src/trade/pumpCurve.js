/**
 * Fills straight on pump.fun's bonding curve (docs/SOLANA_ORDERS.md, "Direct
 * curve fills"): for a coin still on a SOL curve, the order service sells with
 * pump.fun's own `sell_v3` and buys with `buy_exact_quote_in_v3`, with the
 * user's transit as the trader, instead of asking Jupiter for a route. That
 * takes Jupiter (one request every two seconds without a key) out of the path
 * when many orders fire at once, as on a rug, and needs fewer accounts.
 *
 * The accounts are pump.fun's published IDL's (github.com/pump-fun/pump-public-docs,
 * idl/pump.json, read 24 November 2026), in its order; every address but one
 * is derived as the IDL says. The buyback fee recipient isn't: it is one of the
 * eight in pump.fun's Global account (`buyback_fee_recipients`), read from the
 * chain. Both instructions are on the order program's fixed swap list.
 *
 * Nothing here prices a fill: the order service simulates the whole fill, and
 * the order program checks the user's price on what actually reaches them.
 */
const crypto = require('crypto');
const k = require('@solana/kit');
const { cached } = require('../lib/cache');
const { encode: b58encode } = require('../lib/base58');
const rpc = require('../providers/rpc');
const op = require('./solanaOrderProgram');

const PUMP = op.P.pumpFun;
const FEE_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const SOL_QUOTES = new Set([op.WSOL, '11111111111111111111111111111111']);
const disc = name => crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const DISC = { sellV3: disc('sell_v3'), buyExactQuoteInV3: disc('buy_exact_quote_in_v3') };
// Global's buyback_fee_recipients: 8 + 1 + 32 + 32 + 4×8 + 8 + 32 + 1 + 8 + 8 + 7×32 + 32 + 32 + 1 + 32 + 32 + 1 + 7×32 + 1 (the IDL's field order).
const BUYBACK_AT = 741;
const BUYBACK_COUNT = 8;

const enc = () => k.getAddressEncoder();
const bytesOf = a => Buffer.from(enc().encode(k.address(a)));
const pda = async (program, seeds) => (await k.getProgramDerivedAddress({ programAddress: k.address(program), seeds }))[0];

/** pump.fun's fixed addresses: its Global account, its event authority, and the fee program's config for it. */
async function fixed() {
  return {
    global: await pda(PUMP, [Buffer.from('global')]),
    eventAuthority: await pda(PUMP, [Buffer.from('__event_authority')]),
    feeConfig: await pda(FEE_PROGRAM, [Buffer.from('fee_config'), bytesOf(PUMP)]),
  };
}

/** The buyback fee recipients pump.fun's Global account lists (non-empty ones), read from its data. */
function buybackRecipients(globalData) {
  const b = Buffer.from(globalData);
  const out = [];
  for (let i = 0; i < BUYBACK_COUNT; i++) {
    const at = BUYBACK_AT + i * 32;
    if (b.length < at + 32) break;
    const key = b.subarray(at, at + 32);
    if (key.some(x => x !== 0)) out.push(b58encode(key));
  }
  return out;
}

/** A bonding curve's state from its data: { complete, quoteMint, virtualToken, virtualQuote }. */
function curveState(data) {
  const b = Buffer.from(data);
  if (b.length < 115) return null;
  return {
    virtualToken: b.readBigUInt64LE(8), virtualQuote: b.readBigUInt64LE(16), realToken: b.readBigUInt64LE(24), realQuote: b.readBigUInt64LE(32),
    complete: b[48] === 1, quoteMint: b58encode(b.subarray(83, 115)),
  };
}

const dataOf = acct => (acct?.data?.[0] ? Buffer.from(acct.data[0], 'base64') : null);

/**
 * The coin's curve when a fill can go straight to it: owned by pump.fun, not
 * complete, priced in SOL. Else null (the order service asks Jupiter).
 */
async function liveCurve(mint) {
  const curve = await op.bondingCurveOf(mint);
  const r = await rpc.solanaRpc('getMultipleAccounts', [[curve], { encoding: 'base64' }]);
  const acct = r?.value?.[0];
  if (!acct || acct.owner !== PUMP) return null;
  const s = curveState(dataOf(acct));
  if (!s || s.complete) return null;
  if (!SOL_QUOTES.has(s.quoteMint) && !/^1{32}$/.test(s.quoteMint)) return null; // a curve priced in something else
  return { curve, ...s };
}

/** One of the buyback fee recipients pump.fun lists (Global is read at most every 10 minutes). */
async function buybackRecipient() {
  const { global } = await fixed();
  const list = await cached('pump:global:buyback', 600, async () => {
    const r = await rpc.solanaRpc('getMultipleAccounts', [[global], { encoding: 'base64' }]);
    return buybackRecipients(dataOf(r?.value?.[0]) || Buffer.alloc(0));
  });
  if (!list.length) throw new Error('pump.fun\'s Global account lists no buyback fee recipient');
  return list[crypto.randomInt(list.length)]; // spread over them, as pump.fun's own clients do
}

/** The v3 accounts, in the IDL's order, for `trader` (the user's transit) trading `mint`. */
async function accounts({ mint, tokenProgram, trader }) {
  const f = await fixed();
  const curve = await op.bondingCurveOf(mint);
  const m = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isSigner, isWritable });
  return [
    m(f.global), m(mint), m(op.WSOL), m(tokenProgram), m(op.P.token),
    m(curve, true), m(await op.ataOf(curve, tokenProgram, mint), true), m(await op.ataOf(curve, op.P.token, op.WSOL), true),
    m(trader, true, true), m(await op.ataOf(trader, tokenProgram, mint), true), m(await op.ataOf(trader, op.P.token, op.WSOL), true),
    m(await op.volumeOf(PUMP, trader), true),
    m(f.feeConfig), m(await module.exports.buybackRecipient(), true), m(op.P.system), m(f.eventAuthority), m(PUMP),
  ];
}

const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

/** sell_v3(amount, min_sol_output): `amount` of the coin for at least `minSol` lamports, paid in SOL to the trader. */
async function sellSwap({ mint, tokenProgram, trader, amount, minSol }) {
  return { programId: PUMP, accounts: await accounts({ mint, tokenProgram, trader }), data: Buffer.concat([DISC.sellV3, u64(amount), u64(minSol)]).toString('base64'), label: 'pump.fun curve (direct)' };
}

/** buy_exact_quote_in_v3(spendable_quote_in, min_tokens_out, partial_fill = false): `spend` lamports for at least `minTokens`. */
async function buySwap({ mint, tokenProgram, trader, spend, minTokens }) {
  return { programId: PUMP, accounts: await accounts({ mint, tokenProgram, trader }), data: Buffer.concat([DISC.buyExactQuoteInV3, u64(spend), u64(minTokens), Buffer.from([0])]).toString('base64'), label: 'pump.fun curve (direct)' };
}

/**
 * What a buy may offer the curve: 99% of what was moved in (room for
 * RektBull's 1%, taken from what pump.fun doesn't use), less HEADROOM for the
 * small fixed amount pump.fun takes from the trader on top (552,720 lamports
 * in the program's check against pump.fun's real program). Unused SOL goes
 * back to the user.
 */
const HEADROOM = 1_000_000n;
const buySpend = amountIn => BigInt(amountIn) * 9900n / 10000n - HEADROOM;

module.exports = { PUMP, FEE_PROGRAM, DISC, BUYBACK_AT, HEADROOM, fixed, buybackRecipients, curveState, liveCurve, buybackRecipient, accounts, sellSwap, buySwap, buySpend };

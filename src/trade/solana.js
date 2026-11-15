/**
 * Solana trades the user signs (Trade desk, stage 2): pump.fun's bonding
 * curve, PumpSwap, Raydium LaunchLab and every token with a pool, all through
 * Jupiter's Swap API v2 Router (providers/jupiter.js), which charges no fee
 * of its own. Paid and paid out in SOL.
 *
 * One transaction per trade, signed once in the user's wallet, all or
 * nothing: Jupiter's swap, then RektBull's fee as a plain SOL transfer to the
 * fee wallet (SWAP_FEE_WALLET_SOLANA), as four.meme buys paid in BNB do
 * (docs/PAYMENTS.md). The fee is 1% (SWAP_FEE_BPS, at most 1%):
 *   - a buy: 1% of the SOL spent; the other 99% is swapped;
 *   - a sell: 1% of the least the sale is sure to bring (Jupiter's minimum),
 *     paid from it after the sale. If the sale fails, so does the fee.
 *
 * RektBull doesn't hand over what Jupiter returns unread. Before anything
 * reaches the wallet (checkInstructions):
 *   - every program in the transaction is one of a fixed few (System, SPL
 *     Token, Token-2022, Associated Token Account, Compute Budget, Jupiter v6);
 *   - the user is the only signer named, and pays;
 *   - System and Token instructions only wrap and unwrap the user's own
 *     wrapped SOL; account creations are only the user's own token accounts;
 *   - Jupiter's swap is route_v2 or shared_accounts_route_v2, the only Jupiter
 *     instruction, for exactly the amount, tokens and slippage asked, with no
 *     platform fee and no share of positive slippage, and its output goes to
 *     the user's own token account;
 *   - the address lookup tables hold, onchain, what Jupiter says they hold;
 *   - the transaction then runs in a simulation (simulateTransaction), and the
 *     buy is refused unless the user's token account would receive at least
 *     the minimum.
 *
 * The buy checks are the EVM ones (rules.js): RektBull's token check
 * (critical stops a buy; no answer on whether it can be sold stops it too),
 * the bundle and insider check for a token under a week old, the per-trade
 * amount, and selling straight back (Jupiter's price). Sells skip them.
 */
const k = require('@solana/kit');
const env = require('../config/env');
const logger = require('../config/logger');
const { cached } = require('../lib/cache');
const { isSolanaAddress, decode: b58decode } = require('../lib/base58');
const rpc = require('../providers/rpc');
const jupiter = require('../providers/jupiter');
const prices = require('../providers/prices');
const { TradeBlocked } = require('./zeroex');

const P = {
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  compute: 'ComputeBudget111111111111111111111111111111',
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
};
const ALLOWED = new Set(Object.values(P));
const TOKEN_PROGRAMS = new Set([P.token, P.token2022]);
const WSOL = 'So11111111111111111111111111111111111111112';
const LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
const SOL = { priceId: 'coingecko:solana', decimals: 9 };
const MAX_FEE_BPS = 100;
const RENT_EXEMPT_MIN = 890880n; // lamports an empty account must hold; the fee wallet needs at least this
const RESERVE_LAMPORTS = 10_000_000n; // 0.01 SOL kept back on a buy: the network fee and new token accounts' rent
const CU_MAX = 1_400_000;
const CU_HEADROOM = 1.2; // the compute limit: what the simulation used, plus a fifth
const PRIORITY_CAP_LAMPORTS = 5_000_000n; // the most RektBull suggests paying for priority: 0.005 SOL
const SPEEDS = { standard: null, fast: 75, fastest: 95 };

const disc = name => require('crypto').createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const ROUTE_V2 = disc('route_v2');
const SHARED_ROUTE_V2 = disc('shared_accounts_route_v2');

const u64 = (b, o) => b.readBigUInt64LE(o);
const lamportsToSol = l => Number(l) / 1e9;
const fmtSol = l => lamportsToSol(l).toFixed(9).replace(/\.?0+$/, '');

/** The associated token account of owner for mint under a token program. */
async function ata(owner, tokenProgram, mint) {
  const enc = k.getAddressEncoder();
  const [addr] = await k.getProgramDerivedAddress({ programAddress: k.address(P.ata), seeds: [enc.encode(k.address(owner)), enc.encode(k.address(tokenProgram)), enc.encode(k.address(mint))] });
  return addr;
}

/** The fee: { bps, wallet } when a fee wallet is set and can receive it, else null (trade without it, as on EVM). */
async function solanaFee() {
  const wallet = env.swapFeeWalletSolana;
  if (!wallet) return null;
  if (!isSolanaAddress(wallet)) { logger.warn('SWAP_FEE_WALLET_SOLANA is not a Solana address: trading without the fee'); return null; }
  // An empty account can't take a transfer smaller than the rent-exempt minimum: it must be funded first.
  const lamports = await cached(`solana:feewallet:${wallet}`, 600, async () => Number((await rpc.solanaRpc('getBalance', [wallet]))?.value ?? 0)).catch(() => null);
  if (lamports !== null && BigInt(lamports) < RENT_EXEMPT_MIN) { logger.warn('the Solana fee wallet holds less than the rent-exempt minimum: trading without the fee'); return null; }
  return { bps: Math.min(env.swapFeeBps, MAX_FEE_BPS), wallet };
}

/* ── Reading Jupiter's instructions ───────────────────────────────────── */

const refuse = why => new TradeBlocked(`Jupiter's transaction didn't pass RektBull's checks (${why}), so it wasn't sent to your wallet.`);

/**
 * Checks every instruction /build returned (see the header) and reads the
 * swap's own terms. Returns { quotedOut, minOut, destination, slippageBps }.
 */
async function checkInstructions(b, { wallet, inputMint, outputMint, amount, slippageBps }) {
  const all = [...(b.computeBudgetInstructions || []), ...(b.setupInstructions || []), b.swapInstruction, ...(b.cleanupInstruction ? [b.cleanupInstruction] : []), ...(b.otherInstructions || [])];
  if (b.tipInstruction) throw refuse('a tip instruction RektBull didn\'t ask for');
  const wsolAtas = new Set([await ata(wallet, P.token, WSOL)]);
  const ownAtas = new Set(wsolAtas);
  for (const ix of all) {
    if (!ALLOWED.has(ix.programId)) throw refuse(`a call to ${ix.programId}`);
    if (ix.programId === P.jupiter && ix !== b.swapInstruction) throw refuse('a second Jupiter instruction');
    for (const a of ix.accounts) if (a.isSigner && a.pubkey !== wallet) throw refuse(`a signer other than your wallet: ${a.pubkey}`);
    const data = Buffer.from(ix.data || '', 'base64');
    const acc = i => ix.accounts[i]?.pubkey;
    if (ix.programId === P.ata) {
      // create (0 / empty) or create_idempotent (1): [payer, account, owner, mint, system, token program]
      if (!(data.length === 0 || (data.length === 1 && data[0] <= 1))) throw refuse('an unexpected token account instruction');
      if (acc(0) !== wallet || acc(2) !== wallet || !TOKEN_PROGRAMS.has(acc(5))) throw refuse('a token account for someone else');
      if (acc(1) !== await ata(wallet, acc(5), acc(3))) throw refuse('a token account at an unexpected address');
      ownAtas.add(acc(1));
    } else if (ix.programId === P.system) {
      // Only wrapping SOL: Transfer (2) from the wallet to its own wrapped-SOL account.
      if (data.length !== 12 || data.readUInt32LE(0) !== 2 || acc(0) !== wallet || !wsolAtas.has(acc(1))) throw refuse('a SOL transfer other than wrapping your own SOL');
    } else if (TOKEN_PROGRAMS.has(ix.programId)) {
      // SyncNative (17) on, or CloseAccount (9) of, the wallet's wrapped-SOL account, back to the wallet.
      if (data.length === 1 && data[0] === 17 && wsolAtas.has(acc(0))) continue;
      if (data.length === 1 && data[0] === 9 && wsolAtas.has(acc(0)) && acc(1) === wallet && acc(2) === wallet) continue;
      throw refuse('a token instruction other than wrapping or unwrapping your own SOL');
    }
  }

  const sw = b.swapInstruction;
  if (sw.programId !== P.jupiter) throw refuse('the swap isn\'t Jupiter\'s');
  const data = Buffer.from(sw.data, 'base64');
  const acc = i => sw.accounts[i]?.pubkey;
  let o, user, dest, srcMint, dstMint, dstProgram, extraDest = null;
  if (data.subarray(0, 8).equals(ROUTE_V2)) {
    // route_v2: [authority, source, destination, source mint, destination mint, source token program, destination token program, destination account (optional), event authority, program]
    o = 8;
    [user, dest, srcMint, dstMint, dstProgram, extraDest] = [acc(0), acc(2), acc(3), acc(4), acc(6), acc(7)];
  } else if (data.subarray(0, 8).equals(SHARED_ROUTE_V2)) {
    // shared_accounts_route_v2 (id first): [program authority, authority, source, program source, program destination, destination, source mint, destination mint, source token program, destination token program, event authority, program]
    o = 9;
    [user, dest, srcMint, dstMint, dstProgram] = [acc(1), acc(5), acc(6), acc(7), acc(9)];
  } else {
    throw refuse('a kind of Jupiter swap RektBull doesn\'t check yet');
  }
  if (data.length < o + 22) throw refuse('a swap too short to read');
  const inAmount = u64(data, o);
  const quotedOut = u64(data, o + 8);
  const slip = data.readUInt16LE(o + 16);
  const platformFee = data.readUInt16LE(o + 18);
  const positiveSlippage = data.readUInt16LE(o + 20);
  if (user !== wallet || !sw.accounts[o === 8 ? 0 : 1]?.isSigner) throw refuse('a swap not signed by your wallet');
  if (srcMint !== inputMint || dstMint !== outputMint) throw refuse('a swap of different tokens');
  if (inAmount !== BigInt(amount)) throw refuse(`a swap of ${inAmount}, not ${amount}`);
  if (slip !== Number(slippageBps)) throw refuse(`${slip / 100}% slippage, not ${slippageBps / 100}%`);
  if (platformFee !== 0 || positiveSlippage !== 0) throw refuse('a fee taken inside the swap');
  if (extraDest && extraDest !== P.jupiter && extraDest !== dest) throw refuse('the output sent to another account');
  if (!TOKEN_PROGRAMS.has(dstProgram) || dest !== await ata(wallet, dstProgram, dstMint)) throw refuse('the output sent to an account that isn\'t yours');
  if (String(quotedOut) !== String(b.outAmount)) throw refuse('a swap that doesn\'t match its quote');
  const minOut = quotedOut * BigInt(10000 - slip) / 10000n;
  return { quotedOut, minOut, destination: dest, destinationProgram: dstProgram, slippageBps: slip };
}

/**
 * The lookup tables, read from the chain: each address Jupiter says a table
 * holds must be what it holds at that place. (The wallet resolves the tables
 * onchain, so a wrong list would quietly swap accounts in the transaction.)
 */
async function checkLookupTables(b) {
  const tables = Object.entries(b.addressesByLookupTableAddress || {});
  if (!tables.length) return;
  const onchain = await cached(`solana:alt:${tables.map(([t, l]) => `${t}:${l.length}`).join(',')}`, 600, async () => {
    const r = await rpc.solanaRpc('getMultipleAccounts', [tables.map(([t]) => t), { encoding: 'base64' }]);
    return (r?.value || []).map(a => (a && a.owner === LOOKUP_TABLE_PROGRAM ? a.data[0] : null));
  });
  const enc = k.getBase58Decoder();
  tables.forEach(([table, list], n) => {
    if (!onchain[n]) throw refuse(`a lookup table that isn't one onchain: ${table}`);
    const data = Buffer.from(onchain[n], 'base64');
    const held = Math.floor((data.length - 56) / 32);
    if (list.length > held) throw refuse(`a lookup table said to hold more than it does: ${table}`);
    list.forEach((addr, i) => {
      if (enc.decode(data.subarray(56 + i * 32, 88 + i * 32)) !== addr) throw refuse(`a lookup table that doesn't hold what Jupiter said: ${table}`);
    });
  });
}

/* ── Building the transaction ─────────────────────────────────────────── */

const ROLE = a => (a.isSigner ? (a.isWritable ? k.AccountRole.WRITABLE_SIGNER : k.AccountRole.READONLY_SIGNER) : (a.isWritable ? k.AccountRole.WRITABLE : k.AccountRole.READONLY));
const toIx = j => ({ programAddress: k.address(j.programId), accounts: j.accounts.map(a => ({ address: k.address(a.pubkey), role: ROLE(a) })), data: new Uint8Array(Buffer.from(j.data || '', 'base64')) });
const cuLimitIx = units => ({ programAddress: k.address(P.compute), accounts: [], data: new Uint8Array([2, ...Buffer.from(Uint32Array.of(units).buffer)]) });
function cuPriceIx(microLamports) {
  const b = Buffer.alloc(9); b[0] = 3; b.writeBigUInt64LE(BigInt(microLamports), 1);
  return { programAddress: k.address(P.compute), accounts: [], data: new Uint8Array(b) };
}
function transferIx(from, to, lamports) {
  const b = Buffer.alloc(12); b.writeUInt32LE(2, 0); b.writeBigUInt64LE(BigInt(lamports), 4);
  return { programAddress: k.address(P.system), accounts: [{ address: k.address(from), role: k.AccountRole.WRITABLE_SIGNER }, { address: k.address(to), role: k.AccountRole.WRITABLE }], data: new Uint8Array(b) };
}

/**
 * The unsigned version-0 transaction, base64: our compute budget, Jupiter's
 * setup, swap and cleanup (its own compute budget left out), then the fee.
 */
function compose({ wallet, b, fee, units, microLamports }) {
  const ixs = [cuLimitIx(units), ...(microLamports > 0 ? [cuPriceIx(microLamports)] : []),
    ...(b.setupInstructions || []).map(toIx), toIx(b.swapInstruction), ...(b.cleanupInstruction ? [toIx(b.cleanupInstruction)] : []), ...(b.otherInstructions || []).map(toIx),
    ...(fee && fee.lamports > 0n ? [transferIx(wallet, fee.wallet, fee.lamports)] : [])];
  const blockhash = k.getBase58Decoder().decode(Uint8Array.from(b.blockhashWithMetadata.blockhash));
  const tables = Object.fromEntries(Object.entries(b.addressesByLookupTableAddress || {}).map(([t, list]) => [k.address(t), list.map(x => k.address(x))]));
  const msg = k.pipe(
    k.createTransactionMessage({ version: 0 }),
    m => k.setTransactionMessageFeePayer(k.address(wallet), m),
    m => k.setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(b.blockhashWithMetadata.lastValidBlockHeight) }, m),
    m => k.appendTransactionMessageInstructions(ixs, m),
    m => k.compressTransactionMessageUsingAddressLookupTables(m, tables),
  );
  const tx = k.compileTransaction(msg);
  const wire = k.getBase64EncodedWireTransaction(tx);
  const bytes = Buffer.from(wire, 'base64').length;
  if (bytes > 1232) throw new TradeBlocked(`This route makes a transaction of ${bytes} bytes, over Solana's 1,232: try a smaller amount.`);
  return { transaction: wire, bytes, lastValidBlockHeight: Number(b.blockhashWithMetadata.lastValidBlockHeight) };
}

/** The compute unit price for a speed (micro-lamports), from what the swap's accounts paid lately; null leaves Jupiter's. */
async function priorityPrice(speed, b, units) {
  if (!(speed in SPEEDS)) return null;
  if (!SPEEDS[speed]) return null;
  const writable = [...new Set(b.swapInstruction.accounts.filter(a => a.isWritable).map(a => a.pubkey))].slice(0, 128);
  const fees = (await rpc.solanaRpc('getRecentPrioritizationFees', [writable]) || []).map(f => Number(f.prioritizationFee)).filter(f => f > 0).sort((x, y) => x - y);
  if (!fees.length) return 0;
  const price = fees[Math.min(fees.length - 1, Math.floor(fees.length * SPEEDS[speed] / 100))];
  // Never more than the cap in total: price × units / 1e6 lamports.
  return Math.min(price, Number(PRIORITY_CAP_LAMPORTS * 1_000_000n / BigInt(units)));
}
/** Jupiter's own compute unit price, if it set one. */
function jupiterPrice(b) {
  for (const ix of b.computeBudgetInstructions || []) {
    const d = Buffer.from(ix.data || '', 'base64');
    if (d.length === 9 && d[0] === 3) return Number(d.readBigUInt64LE(1));
  }
  return 0;
}

/** Runs the transaction in a simulation. Returns { units, accounts } or throws TradeBlocked saying why it would fail. */
async function simulate(transaction, addresses) {
  const r = await rpc.solanaRpc('simulateTransaction', [transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', accounts: { encoding: 'base64', addresses } }]);
  const v = r?.value;
  if (!v) throw new TradeBlocked('The trade couldn\'t be simulated just now. Nothing was sent; try again.');
  if (v.err) {
    const logs = (v.logs || []).filter(l => /Error|failed|insufficient|slippage/i.test(l)).slice(-3).join(' · ');
    throw new TradeBlocked(`In a simulation this trade fails${logs ? `: ${logs}` : ` (${JSON.stringify(v.err)})`}. Nothing was sent.`);
  }
  return { units: Number(v.unitsConsumed || 0), accounts: v.accounts || [] };
}
/** A token account's amount from its raw data (base64), 0 when it doesn't exist. */
const tokenAmount = acct => (acct?.data?.[0] ? Buffer.from(acct.data[0], 'base64').readBigUInt64LE(64) : 0n);

/** Builds, simulates and sizes the transaction. Returns the composed transaction and what the simulation saw. */
async function assemble({ wallet, b, fee, speed, watch }) {
  await checkLookupTables(b);
  const first = compose({ wallet, b, fee, units: CU_MAX, microLamports: jupiterPrice(b) });
  const sim = await simulate(first.transaction, watch);
  const units = Math.min(CU_MAX, Math.ceil(Math.max(sim.units, 50_000) * CU_HEADROOM));
  const chosen = await priorityPrice(speed, b, units).catch(() => null);
  const microLamports = chosen === null ? jupiterPrice(b) : chosen;
  const tx = compose({ wallet, b, fee, units, microLamports });
  const priorityLamports = BigInt(Math.ceil(units * microLamports / 1e6));
  return { ...tx, sim, units, microLamports, priority: { speed, lamports: priorityLamports.toString(), sol: fmtSol(priorityLamports), source: chosen === null ? 'Jupiter\'s suggested priority fee' : `the ${SPEEDS[speed]}th percentile of what the swap's accounts paid in recent blocks (getRecentPrioritizationFees)` } };
}

/* ── The trade ─────────────────────────────────────────────────────────── */

async function accounts(addresses) {
  const r = await rpc.solanaRpc('getMultipleAccounts', [addresses, { encoding: 'base64' }]);
  return r?.value || [];
}

/** The mint's token program, from who owns the mint account. */
async function mintProgram(mint) {
  const [m] = await accounts([mint]);
  if (!m || !TOKEN_PROGRAMS.has(m.owner)) throw new TradeBlocked('That isn\'t a token mint on Solana.');
  return m.owner;
}

/**
 * Every check, a firm route, and the transaction for the wallet to sign.
 * Throws TradeBlocked saying which check failed.
 */
async function prepare({ accountId, wallet, side, token, base, amountUsd, sellFraction, acknowledgeRisks = false }) {
  const rules = require('./rules');
  if (!env.tradingEnabled) throw new TradeBlocked('Trading is switched off (TRADING_ENABLED).');
  if (!wallet) throw new TradeBlocked('Link a Solana wallet to your account to trade on Solana.');
  if (!['buy', 'sell'].includes(side)) throw new TradeBlocked('side must be "buy" or "sell".');
  if (!isSolanaAddress(String(token || ''))) throw new TradeBlocked('token must be a Solana mint address.');
  if (token === WSOL) throw new TradeBlocked('That is SOL itself; name the token to buy or sell.');
  if (base && String(base).toUpperCase() !== 'SOL') throw new TradeBlocked('On Solana, RektBull trades against SOL: base must be SOL.');
  const settings = await rules.settingsFor(accountId);
  const [price, fee, program] = await Promise.all([prices.basePrice(SOL), solanaFee(), mintProgram(token)]);
  const slippageBps = settings.slippage_bps;
  const checks = [];
  const tokenAta = await ata(wallet, program, token);

  if (side === 'buy') {
    const usd = Number(amountUsd);
    if (!(usd > 0)) throw new TradeBlocked('amount_usd must be a positive number for a buy.');
    if (usd > settings.max_trade_usd) throw new TradeBlocked(`$${usd} is over your per-trade amount of $${settings.max_trade_usd}. Change it in your trading settings.`);
    checks.push({ check: 'per_trade_amount', ok: true, detail: `$${usd} of your $${settings.max_trade_usd} per trade` });
    const total = BigInt(Math.round(usd / price * 1e9));
    const feeLamports = fee ? total * BigInt(fee.bps) / 10000n : 0n;
    const swapIn = total - feeLamports;
    const [own] = await accounts([wallet]);
    const have = BigInt(own?.lamports || 0);
    if (have < total + RESERVE_LAMPORTS) throw new TradeBlocked(`Your wallet holds ${fmtSol(have)} SOL of the ${fmtSol(total)} SOL this buy needs, plus about 0.01 SOL for the network fee and new token accounts.`);

    const dd = require('../services/dueDiligence');
    const [riskR, launchR, buildR] = await Promise.allSettled([
      dd.quickCheck({ chain: 'solana', token }),
      require('../services/launches').forTrade({ chain: 'solana', token }),
      jupiter.build({ inputMint: WSOL, outputMint: token, amount: swapIn, slippageBps, taker: wallet }),
    ]);
    const take = r => { if (r.status === 'rejected') throw r.reason.isJupiter ? new TradeBlocked(r.reason.message) : r.reason; return r.value; };
    const risk = take(riskR);
    if (risk.incomplete) throw new TradeBlocked(`RektBull couldn't check whether this token can be sold (${risk.incomplete}) Not buying.`);
    if (risk.verdict === 'critical') throw new TradeBlocked(`RektBull's token check found a critical risk: ${risk.flags.find(f => f.severity === 'critical')?.title}. Not buying.`);
    const launch = take(launchR);
    if (launch.risk === 'block') throw new TradeBlocked(`RektBull's bundle check found a critical risk: ${launch.flags.find(f => f.severity === 'critical').title}. Not buying.`);
    const high = [
      ...risk.flags.filter(f => f.severity === 'high'),
      ...(launch.risk === 'confirm' ? launch.flags.filter(f => f.severity === 'high').map(f => ({ id: 'bundle', ...f })) : []),
      ...(launch.risk === 'unknown' ? [{ id: 'bundle_unchecked', severity: 'high', title: 'This token is under a week old and RektBull couldn\'t check it for a bundled launch', evidence: launch.detail, source: 'Launch Safety' }] : []),
    ];
    if (high.length && !acknowledgeRisks) {
      const err = new TradeBlocked(`RektBull's checks found ${high.length} high risk${high.length > 1 ? 's' : ''}: ${high.map(f => f.title).join('; ')}. Read them, then confirm to go ahead.`);
      err.needsAcknowledgement = true;
      err.risks = high;
      throw err;
    }
    checks.push({ check: 'token_risk', ok: true, detail: `verdict ${risk.verdict}`, flags: risk.flags, acknowledged: high.length ? high.map(f => f.id) : [] });
    if (launch.young) {
      checks.push(launch.risk === 'unknown'
        ? { check: 'bundle', ok: false, detail: `the bundle check couldn't run (${launch.detail}); you confirmed going ahead without it`, flags: [] }
        : { check: 'bundle', ok: true, detail: `launch check: ${launch.detail}`, flags: launch.flags || [] });
    }

    const b = take(buildR);
    const terms = await checkInstructions(b, { wallet, inputMint: WSOL, outputMint: token, amount: swapIn, slippageBps });
    checks.push({ check: 'route', ok: true, detail: `${b.routePlan.map(p => p.swapInfo.label).join(' → ')}, through Jupiter's Router (no Jupiter fee); every instruction checked`, source: 'Jupiter Swap API v2' });

    // Selling straight back what this buy gets, at Jupiter's price, against everything spent (fee included).
    const back = await jupiter.quote({ inputMint: token, outputMint: WSOL, amount: terms.quotedOut }).catch(err => { if (err.isJupiter) throw new TradeBlocked(err.message); throw err; });
    if (back === null) throw new TradeBlocked('There is no route to sell this token back: it may be a honeypot. Not buying.');
    const lossPct = Number((total - back) * 10000n / total) / 100;
    if (lossPct > settings.max_round_trip_loss_pct) throw new TradeBlocked(`Selling straight back would lose ${lossPct.toFixed(1)}%, above your ${settings.max_round_trip_loss_pct}% limit: the token may tax transfers, or its pool is thin.`);
    checks.push({ check: 'sell_back', ok: true, detail: `selling straight back loses ${lossPct.toFixed(1)}% (fees included; limit ${settings.max_round_trip_loss_pct}%)`, source: 'Jupiter quote' });

    const feeView = fee && feeLamports > 0n ? { wallet: fee.wallet, lamports: feeLamports } : null;
    const [pre] = await accounts([tokenAta]);
    const built = await assemble({ wallet, b, fee: feeView, speed: settings.send_speed, watch: [tokenAta] });
    const received = tokenAmount(built.sim.accounts[0]) - tokenAmount(pre);
    if (received < terms.minOut) throw new TradeBlocked('In a simulation this buy delivers less than its minimum. Nothing was sent.');
    checks.push({ check: 'simulation', ok: true, detail: `the whole transaction ran in a simulation and delivered ${received} of the token (at least ${terms.minOut} guaranteed)`, source: 'Solana RPC simulateTransaction' });
    return planOf({ side, token, wallet, price, usd, total, swapIn, terms, fee, feeLamports, built, checks, b, slippageBps });
  }

  const fraction = Number(sellFraction ?? 1);
  if (!(fraction > 0 && fraction <= 1)) throw new TradeBlocked('sell_fraction must be above 0 and at most 1 (1 sells everything).');
  const [held] = await accounts([tokenAta]);
  const balance = tokenAmount(held);
  if (balance === 0n) throw new TradeBlocked('Your wallet holds none of this token (in its main token account for it).');
  const amount = balance * BigInt(Math.round(fraction * 10000)) / 10000n;
  if (amount === 0n) throw new TradeBlocked('That fraction of your holding rounds to nothing.');
  const b = await jupiter.build({ inputMint: token, outputMint: WSOL, amount, slippageBps, taker: wallet }).catch(err => { if (err.isJupiter) throw new TradeBlocked(err.message); throw err; });
  const terms = await checkInstructions(b, { wallet, inputMint: token, outputMint: WSOL, amount, slippageBps });
  checks.push({ check: 'sell', ok: true, detail: 'Sells skip the buy checks: a sale is how you get out.' });
  checks.push({ check: 'route', ok: true, detail: `${b.routePlan.map(p => p.swapInfo.label).join(' → ')}, through Jupiter's Router (no Jupiter fee); every instruction checked`, source: 'Jupiter Swap API v2' });
  // The fee: a share of the least the sale is sure to bring, paid from it after it, in the same transaction.
  const feeLamports = fee ? terms.minOut * BigInt(fee.bps) / 10000n : 0n;
  const built = await assemble({ wallet, b, fee: fee && feeLamports > 0n ? { wallet: fee.wallet, lamports: feeLamports } : null, speed: settings.send_speed, watch: [tokenAta] });
  checks.push({ check: 'simulation', ok: true, detail: 'the whole transaction ran in a simulation without an error', source: 'Solana RPC simulateTransaction' });
  return planOf({ side, token, wallet, price, amount, terms, fee, feeLamports, built, checks, b, slippageBps, fraction });
}

function planOf({ side, token, wallet, price, usd, total, swapIn, amount, terms, fee, feeLamports, built, checks, b, slippageBps, fraction }) {
  const feeUsd = Math.round(lamportsToSol(feeLamports) * price * 100) / 100;
  const feeView = fee && feeLamports > 0n
    ? { pct: fee.bps / 100, asset: 'SOL', amount: fmtSol(feeLamports), usd: feeUsd, taken_by: side === 'buy' ? 'a SOL transfer to RektBull in the same transaction as the buy' : 'a SOL transfer to RektBull from the sale, in the same transaction: a share of the least the sale is sure to bring' }
    : null;
  const valueUsd = side === 'buy' ? usd : lamportsToSol(terms.minOut - feeLamports) * price;
  const route = b.routePlan.map(p => p.swapInfo.label);
  return {
    chain: 'solana', wallet, side, token, base: 'SOL',
    valueUsd: Math.round(valueUsd * 100) / 100,
    ...(fraction ? { sellFraction: fraction } : {}),
    quote: { sellAmount: side === 'buy' ? total : amount, buyAmount: terms.quotedOut, minBuyAmount: side === 'buy' ? terms.minOut : terms.minOut - feeLamports },
    summary: {
      text: side === 'buy'
        ? `Buy $${usd.toFixed(2)} of ${token} with SOL on Solana (${fmtSol(swapIn)} SOL swapped, through ${route.join(' → ')})`
        : `Sell ${Math.round(fraction * 100)}% of ${token} for SOL (at least ${fmtSol(terms.minOut - feeLamports)} SOL after the fee, about $${valueUsd.toFixed(2)}) on Solana, through ${route.join(' → ')}`,
      sell_amount: (side === 'buy' ? total : amount).toString(),
      buy_amount: terms.quotedOut.toString(),
      min_buy_amount: (side === 'buy' ? terms.minOut : terms.minOut - feeLamports).toString(),
      slippage_pct: slippageBps / 100,
      fee: feeView,
      priority_fee: built.priority,
    },
    checks,
    solana: { transaction: built.transaction, last_valid_block_height: built.lastValidBlockHeight, bytes: built.bytes, compute_units: built.units, route },
  };
}

/* ── Confirming a trade the wallet sent ───────────────────────────────── */

/** True for a Solana transaction signature (base58, 64 bytes). */
function isSignature(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s)) return false;
  try { return b58decode(s).length === 64; } catch { return false; }
}

/**
 * How much of `mint` the transaction moved for `owner`: positive in, negative
 * out, from the transaction's own token balances; null when it hasn't landed.
 */
async function moved(signature, owner, mint) {
  const tx = await rpc.solanaRpc('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  if (!tx) return null;
  if (tx.meta?.err) return { failed: true };
  const sum = list => (list || []).filter(x => x.owner === owner && x.mint === mint).reduce((t, x) => t + BigInt(x.uiTokenAmount.amount), 0n);
  return { amount: sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances) };
}

module.exports = { prepare, checkInstructions, checkLookupTables, compose, simulate, ata, moved, isSignature, solanaFee, WSOL, P, ROUTE_V2, SHARED_ROUTE_V2 };

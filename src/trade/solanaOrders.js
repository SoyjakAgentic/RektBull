/**
 * Orders on Solana (docs/SOLANA_ORDERS.md, "The trade service"): a stop-loss,
 * a take-profit or a Meme Watch exit the user places in RektBull's order
 * program, filled by RektBull's executor when it fires. The user's wallet
 * signs the order and an approval for exactly the coins it sells; the program
 * then lets the executor do one thing: sell them at the user's floor or
 * better, before the order's end date, with the SOL going only to the user.
 * Nobody holds the user's keys or funds between transactions.
 *
 *   stop_loss        fires when the coins' value falls to the trigger (DexScreener's price);
 *   take_profit      fires when it rises to the trigger;
 *   meme_watch_exit  fires when Meme Watch raises a critical alert for the coin (launch-bundle
 *                    wallets selling, liquidity pulled), from the stream or its 6-hour check;
 *   limit_buy        buys the coin with the user's SOL (wrapped in their own wallet, and
 *                    approved) when its price falls to their limit, after the Trade desk's buy
 *                    checks, run again before each fill.
 *
 * A fill: Jupiter's route for transit (the user's own program address) as the
 * trader, checked instruction by instruction (trade/solana.js), sized to what
 * the user still holds and approved, priced against the floor before
 * anything is sent, simulated, signed by the executor's KMS key and sent. The
 * program checks the floor again on what actually reached the user; a fill
 * below it fails onchain and costs the user nothing.
 *
 * Off until the program is audited and deployed (SOLANA_ORDERS_ENABLED, its
 * address, the executor's, the fee wallet's), and never against a program
 * that can still be upgraded, except off mainnet when allowed. The emergency
 * stop for automatic trading stops fills; cancelling is never blocked.
 */
const crypto = require('crypto');
const env = require('../config/env');
const db = require('../config/db');
const logger = require('../config/logger');
const { cached } = require('../lib/cache');
const { isSolanaAddress, encode: b58encode } = require('../lib/base58');
const rpc = require('../providers/rpc');
const jupiter = require('../providers/jupiter');
const op = require('./solanaOrderProgram');
const otx = require('./solanaOrderTx');
const privateSend = require('./privateSend');
const { TradeBlocked } = require('./zeroex');

const KINDS = {
  stop_loss: 'Stop-loss',
  take_profit: 'Take-profit',
  meme_watch_exit: 'Meme Watch exit',
  limit_buy: 'Limit buy',
};
const isBuy = row => row.kind === 'limit_buy';
const MAX_DAYS = 30;
const LAMPORTS_PER_BYTE_YEAR = 3480n; // Solana's rent: an account holds two years' worth to be rent-exempt
const rentOf = space => (BigInt(space) + 128n) * LAMPORTS_PER_BYTE_YEAR * 2n;
const ORDER_RENT = rentOf(op.ORDER_SPACE); // 2,185,440 lamports, back to the user when the order closes
const VOLUME_RENT = rentOf(137); // 1,844,400: pump.fun's and PumpSwap's volume account for the user's transit
const FILL_SLIPPAGE_BPS = 500; // Jupiter's own check on a fill; the user's floor, checked by the program, is what protects them
const CU_MAX = 1_400_000;
const PRIORITY_CAP_LAMPORTS = 1_000_000n; // the most the executor pays for priority on one fill: 0.001 SOL
const TOKEN_ACCOUNT_RENT = rentOf(170); // a token account (Token-2022's carries a small extension): about 0.002 SOL
const RETRY_MS = { below_floor: 30_000, failed: 30_000, nothing: 5 * 60_000 };
const SETUP_ERROR = 'needs a one-time setup'; // an order waiting on the user's volume accounts (last_error starts with it)
const FILLS_PER_TICK = 5;
const PREPARED_TTL_MS = 10 * 60_000; // a prepared order never placed is forgotten after this

const sol = l => (Number(l) / 1e9).toFixed(9).replace(/\.?0+$/, '') || '0';
const whole = (raw, decimals) => Number(raw) / 10 ** decimals;
const fmt = n => n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : 2 });
const short = a => `${a.slice(0, 4)}…${a.slice(-4)}`;
const refuse = (message, status = 422) => Object.assign(new TradeBlocked(message), { status });

/* ── Configuration ── */

/** { program, executor, feeWallet, lookupTable } when orders are on; else { off: why }. */
function config() {
  if (!env.solanaOrdersEnabled) return { off: 'Orders on Solana open once RektBull\'s order program has been audited and deployed. Until then, sell from your own wallet on the Trade desk.' };
  const missing = [['SOLANA_ORDERS_PROGRAM_ID', env.solanaOrdersProgramId], ['SOLANA_ORDERS_EXECUTOR', env.solanaOrdersExecutor], ['SOLANA_ORDERS_FEE_WALLET', env.solanaOrdersFeeWallet]]
    .filter(([, v]) => !isSolanaAddress(v)).map(([n]) => n);
  if (missing.length) return { off: `Orders on Solana aren't set up here (${missing.join(', ')}).` };
  return { program: env.solanaOrdersProgramId, executor: env.solanaOrdersExecutor, feeWallet: env.solanaOrdersFeeWallet, lookupTable: isSolanaAddress(env.solanaOrdersLookupTable) ? env.solanaOrdersLookupTable : null };
}

/**
 * The program as deployed: executable, and with no upgrade authority (nobody
 * can change it), unless SOLANA_ORDERS_ALLOW_UPGRADEABLE off mainnet. Kept 10 minutes.
 */
async function programCheck(program) {
  return cached(`solana:orders:program:${program}`, 600, async () => {
    const p = (await rpc.solanaRpc('getAccountInfo', [program, { encoding: 'jsonParsed' }]))?.value;
    if (!p?.executable) return { ok: false, why: `RektBull's order program isn't deployed at ${program}.` };
    const data = p.data?.parsed?.info?.programData;
    const pd = data ? (await rpc.solanaRpc('getAccountInfo', [data, { encoding: 'jsonParsed' }]))?.value : null;
    const authority = pd?.data?.parsed?.info?.authority ?? null;
    if (authority) {
      const genesis = await rpc.solanaRpc('getGenesisHash', []).catch(() => null);
      const mainnet = genesis === require('./solanaExecutor').MAINNET_GENESIS;
      if (!(env.solanaOrdersAllowUpgradeable && env.nodeEnv !== 'production' && !mainnet)) {
        return { ok: false, why: 'RektBull\'s order program can still be upgraded, so RektBull won\'t use it: its upgrade authority must be removed after the audit (docs/SOLANA_ORDERS.md).' };
      }
    }
    return { ok: true, upgradeable: !!authority };
  });
}

/** The configuration, checked against the chain; throws a refusal saying why when orders can't be used. */
async function ready() {
  const cfg = config();
  if (cfg.off) throw refuse(cfg.off, 503);
  const p = await programCheck(cfg.program);
  if (!p.ok) throw refuse(p.why, 503);
  return cfg;
}

/* ── Reading the chain ── */

async function accounts(addresses) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const r = await rpc.solanaRpc('getMultipleAccounts', [addresses.slice(i, i + 100), { encoding: 'base64' }]);
    out.push(...(r?.value || addresses.slice(i, i + 100).map(() => null)));
  }
  return out;
}
const dataOf = acct => (acct?.data?.[0] ? Buffer.from(acct.data[0], 'base64') : null);

/** An SPL token account (Token or Token-2022, the same first 165 bytes). */
function tokenAccount(acct) {
  const b = dataOf(acct);
  if (!b || b.length < 165) return null;
  const key = at => b58encode(b.subarray(at, at + 32));
  return {
    mint: key(0), owner: key(32), amount: b.readBigUInt64LE(64),
    delegate: b.readUInt32LE(72) === 1 ? key(76) : null,
    delegatedAmount: b.readBigUInt64LE(121),
  };
}

/** The mint's token program and decimals. */
async function mintInfo(mint) {
  const [m] = await accounts([mint]);
  if (!m || !op.TOKEN_PROGRAMS.has(m.owner)) throw refuse('That isn\'t a token mint on Solana.');
  return { tokenProgram: m.owner, decimals: dataOf(m)[44] };
}

async function latestBlockhash() {
  const r = await rpc.solanaRpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  return { blockhash: r.value.blockhash, lastValidBlockHeight: Number(r.value.lastValidBlockHeight) };
}

/** Runs an unsigned transaction in a simulation: { units, accounts, logs } or { err, logs }. */
async function simulate(transaction, addresses = []) {
  const r = await rpc.solanaRpc('simulateTransaction', [transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', ...(addresses.length ? { accounts: { encoding: 'base64', addresses } } : {}) }]);
  const v = r?.value;
  if (!v) return { err: 'no answer from the simulation', logs: [] };
  return { err: v.err || null, units: Number(v.unitsConsumed || 0), accounts: v.accounts || [], logs: v.logs || [] };
}
const why = logs => (logs || []).filter(l => /Error|failed|insufficient|BelowLimit|NoRoomForFee/i.test(l)).slice(-2).join(' · ');

/** RektBull's own lookup table, read from the chain (kept 10 minutes). */
async function ownTable(table) {
  if (!table) return {};
  const list = await cached(`solana:orders:alt:${table}`, 600, async () => {
    const [a] = await accounts([table]);
    const b = dataOf(a);
    if (!b || a.owner !== 'AddressLookupTab1e1111111111111111111111111') return [];
    const out = [];
    for (let i = 56; i + 32 <= b.length; i += 32) out.push(b58encode(b.subarray(i, i + 32)));
    return out;
  });
  return list.length ? { [table]: list } : {};
}

/* ── Prices ── */

/** What `amountRaw` of the coin would sell for in SOL now (Jupiter), or null when there's no route. */
async function quoteOut(token, amountRaw) {
  return jupiter.quote({ inputMint: token, outputMint: op.WSOL, amount: amountRaw }).catch(err => {
    if (err.isJupiter) throw refuse(err.message, 503);
    throw err;
  });
}

/* ── Placing an order ── */

const num = (v, lo, hi, dflt, name) => {
  const n = v === undefined || v === null || v === '' ? dflt : Number(v);
  if (!(n >= lo && n <= hi)) throw refuse(`${name} must be from ${lo} to ${hi}.`, 400);
  return n;
};
const pctOf = (x, pct) => BigInt(x) * BigInt(Math.round(pct * 100)) / 10000n;
const net = gross => gross - op.feeOf(gross);

/**
 * The order's terms from what the user asked: { triggerOut, minOut, said }.
 * Amounts in lamports for all of the order; minOut is after RektBull's 1%
 * (or after `netOf`, for orders on BNB Chain and Base: trade/memeOrders.js).
 */
function terms(kind, refOut, body, settings, netOf = net) {
  if (kind === 'stop_loss') {
    const stop = num(body.stop_pct, 1, 95, settings.stop_loss_pct, 'stop_pct');
    const floor = num(body.floor_pct, 2, 99, Math.min(99, stop + 15), 'floor_pct');
    if (floor <= stop) throw refuse('Your floor must be below your stop: floor_pct more than stop_pct.', 400);
    return { triggerOut: pctOf(refOut, 100 - stop), minOut: netOf(pctOf(refOut, 100 - floor)), said: { stop_pct: stop, floor_pct: floor } };
  }
  if (kind === 'take_profit') {
    const take = num(body.take_pct, 1, 10000, settings.take_profit_pct, 'take_pct');
    const slip = num(body.slippage_pct, 0.5, 20, 3, 'slippage_pct');
    const trigger = pctOf(refOut, 100 + take);
    return { triggerOut: trigger, minOut: netOf(pctOf(trigger, 100 - slip)), said: { take_pct: take, slippage_pct: slip } };
  }
  const floor = num(body.floor_pct, 1, 99, 50, 'floor_pct');
  return { triggerOut: null, minOut: netOf(pctOf(refOut, 100 - floor)), said: { floor_pct: floor } };
}

/** The worst case, in plain words, shown before the user signs. */
function worstCase({ kind, amountWhole, symbol, minOut, validUntil }) {
  const date = new Date(validUntil).toISOString().slice(0, 10);
  const what = `your ${fmt(amountWhole)} ${symbol}`;
  const lines = [
    kind === 'take_profit'
      ? `Worst case, even if RektBull were hacked: ${what} are sold for ${sol(minOut)} SOL after the 1% fee (your target less your slippage), at a moment RektBull picks before ${date}. That is more than they would sell for now.`
      : `Worst case, even if RektBull were hacked: ${what} are sold for ${sol(minOut)} SOL after the 1% fee (your floor), at a moment RektBull picks before ${date}, even if the market is higher then.`,
    'Nothing else of yours can be touched: the approval covers only these coins, and the order program sends what they sell for only to your wallet. RektBull never holds them.',
    `If the price falls straight past your floor, the order can't fill below it: you keep the coins, and RektBull tells you.`,
    'To stop it: cancel it here (its deposit comes back), or revoke the approval in your wallet.',
  ];
  return lines;
}

/** Is Meme Watch on for this account? (A Meme Watch exit fires on its alerts.) */
async function memeWatchOn(accountId) {
  if (require('../admin/agentStates').isOff('meme_watch')) return false;
  const { rows } = await db.query(`SELECT enabled FROM agent_settings WHERE account_id = $1 AND agent = 'meme_watch'`, [accountId]);
  return !!rows[0]?.enabled;
}

/**
 * Checks, terms and the transaction for the user's wallet to sign. Throws a
 * refusal saying which check failed.
 */
async function prepare(account, body = {}) {
  const cfg = await ready();
  const owner = account.solana_wallet;
  if (!owner) throw refuse('Link a Solana wallet to your account to place orders on Solana.', 409);
  const kind = String(body.kind || '');
  if (!KINDS[kind]) throw refuse(`kind must be one of ${Object.keys(KINDS).join(', ')}.`, 400);
  const token = String(body.token || '');
  if (!isSolanaAddress(token) || token === op.WSOL) throw refuse('token must be the mint address of the coin to sell.', 400);
  const share = num(body.share_pct, 1, 100, 100, 'share_pct');
  const days = num(body.days, 1, MAX_DAYS, MAX_DAYS, 'days');
  if (kind === 'meme_watch_exit' && !(await memeWatchOn(account.id))) {
    throw refuse('A Meme Watch exit sells when Meme Watch raises a critical alert for the coin. Switch on Meme Watch in My agents first.', 409);
  }
  const settings = await require('./rules').settingsFor(account.id);
  if (kind === 'limit_buy') return prepareBuy(account, body, { cfg, owner, token, days, settings });

  const { tokenProgram, decimals } = await mintInfo(token);
  const source = await op.ataOf(owner, tokenProgram, token);
  const [delegate, transit] = await Promise.all([op.delegateOf(cfg.program), op.transitOf(cfg.program, owner)]);
  const [src] = await accounts([source]);
  const held = tokenAccount(src);
  if (!held || held.amount === 0n) throw refuse('Your wallet holds none of this coin (in its main token account for it).');
  const amountIn = held.amount * BigInt(Math.round(share * 100)) / 10000n;
  if (amountIn === 0n) throw refuse('That share of your holding rounds to nothing.');

  const refOut = await quoteOut(token, amountIn);
  if (refOut === null || refOut === 0n) throw refuse('There is no route to sell this coin for SOL just now (Jupiter), so an order couldn\'t be filled.');
  const t = terms(kind, refOut, body, settings);
  if (t.minOut <= 0n) throw refuse('That floor rounds to nothing; choose a higher one.', 400);

  // An approval replaces the one before it on the same token account, so it covers this order and what's left of the others.
  const { rows: others } = await db.query(
    `SELECT COALESCE(sum(amount_in - filled_in), 0)::text AS left FROM solana_orders WHERE account_id = $1 AND source = $2 AND state IN ('prepared', 'open', 'triggered')`,
    [account.id, source]);
  const MAX_U64 = (1n << 64n) - 1n;
  let approveAmount = amountIn + BigInt(others[0].left);
  if (approveAmount > MAX_U64) approveAmount = MAX_U64;
  const notes = [];
  if (held.delegate && held.delegate !== delegate) notes.push(`This replaces the approval your token account gives ${short(held.delegate)} (a token account has one approval at a time).`);

  // pump.fun's and PumpSwap's volume accounts for transit, once per user, for a pump.fun coin (on its curve or graduated).
  const [curve, ...volumes] = await accounts([await op.bondingCurveOf(token), await op.volumeOf(op.P.pumpFun, transit), await op.volumeOf(op.P.pumpAmm, transit)]);
  const volumeVenues = curve ? [op.P.pumpFun, op.P.pumpAmm].filter((_, i) => !volumes[i]) : [];

  const nonce = crypto.randomBytes(8).readBigUInt64LE() >> 1n; // below 2^63: kept exactly as NUMERIC and in JSON
  const validUntil = Date.now() + days * 86400_000;
  const build = async units => {
    const p = await otx.placeInstructions({ program: cfg.program, owner, executor: cfg.executor, nonce, token, tokenProgram, decimals, source, approveAmount, amountIn, minOut: t.minOut, validUntil: Math.floor(validUntil / 1000), volumeVenues, units });
    const bh = await latestBlockhash();
    return { ...p, ...bh, ...otx.compile({ payer: owner, instructions: p.instructions, ...bh }) };
  };
  const first = await build(null);
  const sim = await simulate(first.transaction, [first.order]);
  if (sim.err) throw refuse(`In a simulation this order fails${why(sim.logs) ? `: ${why(sim.logs)}` : ` (${JSON.stringify(sim.err)})`}. Nothing was sent.`);
  const placed = op.decodeOrder(sim.accounts[0]?.data?.[0] || '');
  if (!placed || placed.owner !== owner || placed.executor !== cfg.executor || placed.inputMint !== token || placed.amountIn !== amountIn || placed.minAmountOut !== t.minOut) {
    throw refuse('In a simulation the order didn\'t come out as prepared. Nothing was sent.');
  }
  const built = await build(Math.min(CU_MAX, Math.ceil(Math.max(sim.units, 20_000) * 1.3)));

  const symbol = (await require('../providers/dexscreener').pairs('solana', [token]).catch(() => ({})))[token]?.symbol || short(token);
  const { rows: [row] } = await db.query(
    `INSERT INTO solana_orders (account_id, owner, order_address, program, nonce, kind, token, symbol, token_program, decimals, source, amount_in, min_out, trigger_out, ref_out, executor, valid_until)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
    [account.id, owner, built.order, cfg.program, nonce.toString(), kind, token, symbol, tokenProgram, decimals, source, amountIn.toString(), t.minOut.toString(), t.triggerOut?.toString() ?? null, refOut.toString(), cfg.executor, new Date(validUntil)]);
  const amountWhole = whole(amountIn, decimals);
  return {
    order: view(row),
    terms: t.said,
    worst_case: worstCase({ kind, amountWhole, symbol, minOut: t.minOut, validUntil }),
    notes,
    costs: {
      order_deposit_sol: sol(ORDER_RENT), order_deposit_note: 'Held by the order account and returned to you when it is filled or cancelled.',
      ...(volumeVenues.length ? { volume_accounts_sol: sol(VOLUME_RENT * BigInt(volumeVenues.length)), volume_accounts_note: `Once per wallet: ${volumeVenues.length === 2 ? 'pump.fun\'s and PumpSwap\'s' : volumeVenues[0] === op.P.pumpFun ? 'pump.fun\'s' : 'PumpSwap\'s'} volume account for your order address, which they need for every trade.` } : {}),
      fee: 'RektBull\'s 1% of the SOL a fill brings, taken by the order program. Nothing if it never fills. RektBull pays each fill\'s network fee.',
    },
    checks: [
      { check: 'holding', ok: true, detail: `${fmt(amountWhole)} of the ${fmt(whole(held.amount, decimals))} ${symbol} in your wallet`, source: 'Solana RPC' },
      { check: 'route', ok: true, detail: `they would sell for ${sol(refOut)} SOL now`, source: 'Jupiter quote' },
      { check: 'simulation', ok: true, detail: 'the whole transaction ran in a simulation and placed this order', source: 'Solana RPC simulateTransaction' },
    ],
    solana: { transaction: built.transaction, last_valid_block_height: built.lastValidBlockHeight, bytes: built.bytes },
  };
}

/** A limit buy's worst case, in plain words, shown before the user signs. */
function worstCaseBuy({ spendSol, minCoins, symbol, validUntil }) {
  const date = new Date(validUntil).toISOString().slice(0, 10);
  return [
    `Worst case, even if RektBull were hacked: your ${spendSol} SOL buys ${fmt(minCoins)} ${symbol} (your limit less your slippage), the 1% fee included, at a moment RektBull picks before ${date}, even if the price is lower then.`,
    'Nothing else of yours can be touched: the approval covers only this SOL, wrapped in your own wallet, and the order program sends the coins only to your wallet. RektBull never holds them.',
    'If the price never comes down to your limit, nothing is bought, and your SOL stays in your wallet, wrapped, until you cancel (which unwraps it).',
    'Before each fill, RektBull runs its token check again: a critical risk stops the buy, and you are told.',
    'To stop it: cancel it here (its deposit comes back and your SOL is unwrapped), or revoke the approval in your wallet.',
  ];
}

/**
 * A limit buy: the Trade desk's buy checks (the per-trade amount, the token
 * check, the bundle check for a young coin, selling straight back), the terms
 * from Jupiter's quote now, and the transaction that wraps the SOL, places the
 * order and approves only that SOL.
 */
async function prepareBuy(account, body, { cfg, owner, token, days, settings }) {
  const spend = num(body.spend_sol, 0.01, 1000, NaN, 'spend_sol');
  const dip = num(body.dip_pct, 1, 95, 20, 'dip_pct');
  const slip = num(body.slippage_pct, 0.5, 20, 3, 'slippage_pct');
  const amountIn = BigInt(Math.round(spend * 1e9));
  const solUsd = await require('../providers/prices').usdPrice('coingecko:solana');
  const spendUsd = Math.round(spend * solUsd * 100) / 100;
  if (spendUsd > settings.max_trade_usd) throw refuse(`$${spendUsd} is over your per-trade amount of $${settings.max_trade_usd}. Change it in your trading settings.`);
  const checks = [{ check: 'per_trade_amount', ok: true, detail: `$${spendUsd} of your $${settings.max_trade_usd} per trade`, source: 'your trading settings; SOL\'s price from DefiLlama' }];

  const { tokenProgram, decimals } = await mintInfo(token);
  const [delegate, transit] = await Promise.all([op.delegateOf(cfg.program), op.transitOf(cfg.program, owner)]);
  const [wsol, ownerOut] = await Promise.all([op.ataOf(owner, op.P.token, op.WSOL), op.ataOf(owner, tokenProgram, token)]);
  const [wallet, wsolAcct, outAcct, curve, ...volumes] = await accounts([owner, wsol, ownerOut, await op.bondingCurveOf(token), await op.volumeOf(op.P.pumpFun, transit), await op.volumeOf(op.P.pumpAmm, transit)]);
  const volumeVenues = curve ? [op.P.pumpFun, op.P.pumpAmm].filter((_, i) => !volumes[i]) : [];
  const newAccounts = (wsolAcct ? 0n : TOKEN_ACCOUNT_RENT) + (outAcct ? 0n : TOKEN_ACCOUNT_RENT);
  const needs = amountIn + ORDER_RENT + newAccounts + VOLUME_RENT * BigInt(volumeVenues.length) + 1_000_000n; // and 0.001 SOL for the network fee
  const have = BigInt(wallet?.lamports || 0);
  if (have < needs) throw refuse(`Your wallet holds ${sol(have)} SOL of the ${sol(needs)} SOL this order needs: the ${spend} SOL to wrap, the order's deposit, new accounts' rent and the network fee.`);

  // The Trade desk's buy checks (trade/solana.js).
  const dd = require('../services/dueDiligence');
  const [risk, launch] = await Promise.all([dd.quickCheck({ chain: 'solana', token }), require('../services/launches').forTrade({ chain: 'solana', token })]);
  if (risk.incomplete) throw refuse(`RektBull couldn't check whether this token can be sold (${risk.incomplete}) Not placing a buy.`);
  if (risk.verdict === 'critical') throw refuse(`RektBull's token check found a critical risk: ${risk.flags.find(f => f.severity === 'critical')?.title}. Not placing a buy.`);
  if (launch.risk === 'block') throw refuse(`RektBull's bundle check found a critical risk: ${launch.flags.find(f => f.severity === 'critical').title}. Not placing a buy.`);
  const high = [
    ...risk.flags.filter(f => f.severity === 'high'),
    ...(launch.risk === 'confirm' ? launch.flags.filter(f => f.severity === 'high').map(f => ({ id: 'bundle', ...f })) : []),
    ...(launch.risk === 'unknown' ? [{ id: 'bundle_unchecked', severity: 'high', title: 'This token is under a week old and RektBull couldn\'t check it for a bundled launch', evidence: launch.detail, source: 'Launch Safety' }] : []),
  ];
  if (high.length && !body.acknowledge_risks) {
    const err = refuse(`RektBull's checks found ${high.length} high risk${high.length > 1 ? 's' : ''}: ${high.map(f => f.title).join('; ')}. Read them, then confirm to go ahead.`);
    err.needsAcknowledgement = true;
    err.risks = high;
    throw err;
  }
  checks.push({ check: 'token_risk', ok: true, detail: `verdict ${risk.verdict}${high.length ? ` (you confirmed ${high.length} high risk${high.length > 1 ? 's' : ''})` : ''}`, source: 'RektBull\'s token check' });
  if (launch.young) checks.push({ check: 'bundle', ok: launch.risk !== 'unknown', detail: launch.risk === 'unknown' ? `the bundle check couldn't run (${launch.detail}); you confirmed going ahead without it` : `launch check: ${launch.detail}`, source: 'Launch Safety' });

  // The terms, from what the SOL (less room for the 1%) would buy now.
  const swapIn = otx.buySwapAmount(amountIn);
  const quote = async (inputMint, outputMint, amount) => jupiter.quote({ inputMint, outputMint, amount }).catch(err => { if (err.isJupiter) throw refuse(err.message, 503); throw err; });
  const refOut = await quote(op.WSOL, token, swapIn);
  if (!refOut) throw refuse('There is no route to buy this coin with SOL just now (Jupiter).');
  const back = await quote(token, op.WSOL, refOut);
  if (back === null) throw refuse('There is no route to sell this coin back: it may be a honeypot. Not placing a buy.');
  const lossPct = Number((amountIn - back) * 10000n / amountIn) / 100;
  if (lossPct > settings.max_round_trip_loss_pct) throw refuse(`Selling straight back would lose ${lossPct.toFixed(1)}%, above your ${settings.max_round_trip_loss_pct}% limit: the token may tax transfers, or its pool is thin.`);
  checks.push({ check: 'sell_back', ok: true, detail: `selling straight back loses ${lossPct.toFixed(1)}% (fees included; limit ${settings.max_round_trip_loss_pct}%)`, source: 'Jupiter quote' });
  const trigger = refOut * 10000n / BigInt(Math.round((100 - dip) * 100));
  const minOut = pctOf(trigger, 100 - slip);
  if (minOut <= 0n) throw refuse('That limit rounds to no coins; spend more.', 400);

  const { rows: others } = await db.query(
    `SELECT COALESCE(sum(amount_in - filled_in), 0)::text AS left FROM solana_orders WHERE account_id = $1 AND source = $2 AND state IN ('prepared', 'open', 'triggered')`,
    [account.id, wsol]);
  const MAX_U64 = (1n << 64n) - 1n;
  let approveAmount = amountIn + BigInt(others[0].left);
  if (approveAmount > MAX_U64) approveAmount = MAX_U64;
  const held = tokenAccount(wsolAcct);
  const notes = [`Your ${spend} SOL is wrapped (as wrapped SOL, in your own wallet) so the order can be approved to spend it; cancelling unwraps it.`];
  if (held?.delegate && held.delegate !== delegate) notes.push(`This replaces the approval your wrapped-SOL account gives ${short(held.delegate)} (a token account has one approval at a time).`);

  const nonce = crypto.randomBytes(8).readBigUInt64LE() >> 1n;
  const validUntil = Date.now() + days * 86400_000;
  const build = async units => {
    const p = await otx.placeBuyInstructions({ program: cfg.program, owner, executor: cfg.executor, nonce, token, tokenProgram, amountIn, minOut, validUntil: Math.floor(validUntil / 1000), wrapLamports: amountIn, approveAmount, volumeVenues, units });
    const bh = await latestBlockhash();
    return { ...p, ...bh, ...otx.compile({ payer: owner, instructions: p.instructions, ...bh }) };
  };
  const first = await build(null);
  const sim = await simulate(first.transaction, [first.order]);
  if (sim.err) throw refuse(`In a simulation this order fails${why(sim.logs) ? `: ${why(sim.logs)}` : ` (${JSON.stringify(sim.err)})`}. Nothing was sent.`);
  const placed = op.decodeOrder(sim.accounts[0]?.data?.[0] || '');
  if (!placed || placed.owner !== owner || placed.executor !== cfg.executor || placed.inputMint !== op.WSOL || placed.outputMint !== token || placed.outputNative || placed.amountIn !== amountIn || placed.minAmountOut !== minOut) {
    throw refuse('In a simulation the order didn\'t come out as prepared. Nothing was sent.');
  }
  checks.push({ check: 'simulation', ok: true, detail: 'the whole transaction ran in a simulation and placed this order', source: 'Solana RPC simulateTransaction' });
  const built = await build(Math.min(CU_MAX, Math.ceil(Math.max(sim.units, 20_000) * 1.3)));

  const symbol = (await require('../providers/dexscreener').pairs('solana', [token]).catch(() => ({})))[token]?.symbol || short(token);
  const { rows: [row] } = await db.query(
    `INSERT INTO solana_orders (account_id, owner, order_address, program, nonce, kind, token, symbol, token_program, decimals, source, amount_in, min_out, trigger_out, ref_out, executor, valid_until, spend_usd)
     VALUES ($1, $2, $3, $4, $5, 'limit_buy', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
    [account.id, owner, built.order, cfg.program, nonce.toString(), token, symbol, tokenProgram, decimals, wsol, amountIn.toString(), minOut.toString(), trigger.toString(), refOut.toString(), cfg.executor, new Date(validUntil), spendUsd]);
  return {
    order: view(row),
    terms: { spend_sol: spend, dip_pct: dip, slippage_pct: slip },
    worst_case: worstCaseBuy({ spendSol: spend, minCoins: whole(minOut, decimals), symbol, validUntil }),
    notes,
    costs: {
      order_deposit_sol: sol(ORDER_RENT), order_deposit_note: 'Held by the order account and returned to you when it is filled or cancelled.',
      ...(newAccounts ? { new_accounts_sol: sol(newAccounts), new_accounts_note: 'Rent for your own wrapped-SOL and coin accounts, which this creates; they stay yours.' } : {}),
      ...(volumeVenues.length ? { volume_accounts_sol: sol(VOLUME_RENT * BigInt(volumeVenues.length)), volume_accounts_note: `Once per wallet: ${volumeVenues.length === 2 ? 'pump.fun\'s and PumpSwap\'s' : volumeVenues[0] === op.P.pumpFun ? 'pump.fun\'s' : 'PumpSwap\'s'} volume account for your order address, which they need for every trade.` } : {}),
      fee: 'RektBull\'s 1% of the SOL a fill spends, taken by the order program. Nothing if it never fills. RektBull pays each fill\'s network fee.',
    },
    checks,
    solana: { transaction: built.transaction, last_valid_block_height: built.lastValidBlockHeight, bytes: built.bytes },
  };
}

/* ── Exits with a buy (trade/solana.js) ── */

/**
 * A stop-loss and/or a take-profit placed in the same transaction as a buy on
 * the Trade desk, for the coins the buy is sure to bring (`minOut`, Jupiter's
 * minimum), so the buy is protected from the moment it lands. Their value is
 * worked out at the buy's own price: what `minOut` of what it gets cost.
 *
 * Returns { off: why } when orders can't be used, or { instructions, addresses,
 * orders, summary }. Nothing is stored here: the trade records the orders
 * (recordExits) only when it's made, and a prepared order never placed is
 * forgotten after 10 minutes.
 */
async function exitsForBuy({ accountId, owner, token, tokenProgram, tokenAta, minOut, quotedOut, swapIn, exits, settings, kinds = ['stop_loss', 'take_profit'].filter(kd => exits[kd]), volumes = true }) {
  const cfg = config();
  if (cfg.off) return { off: cfg.off };
  const p = await programCheck(cfg.program);
  if (!p.ok) return { off: p.why };
  if (!kinds.length) return null;
  const days = num(exits.days, 1, MAX_DAYS, MAX_DAYS, 'days');
  const amountIn = BigInt(minOut);
  const refOut = BigInt(swapIn) * amountIn / BigInt(quotedOut); // at this buy's price
  const [delegate, transit] = await Promise.all([op.delegateOf(cfg.program), op.transitOf(cfg.program, owner)]);
  const [mint, curve, ...vols] = await accounts([token, await op.bondingCurveOf(token), await op.volumeOf(op.P.pumpFun, transit), await op.volumeOf(op.P.pumpAmm, transit)]);
  const decimals = dataOf(mint)[44];
  const missing = curve ? [op.P.pumpFun, op.P.pumpAmm].filter((_, i) => !vols[i]) : [];
  const volumeVenues = volumes ? missing : []; // left out to fit, they come in a setup transaction signed just before
  const { rows: others } = await db.query(
    `SELECT COALESCE(sum(amount_in - filled_in), 0)::text AS left FROM solana_orders WHERE account_id = $1 AND source = $2 AND state IN ('prepared', 'open', 'triggered')`,
    [accountId, tokenAta]);
  const MAX_U64 = (1n << 64n) - 1n;
  let approveAmount = amountIn * BigInt(kinds.length) + BigInt(others[0].left);
  if (approveAmount > MAX_U64) approveAmount = MAX_U64;
  const validUntil = Date.now() + days * 86400_000;
  const orders = [];
  for (const kind of kinds) {
    const t = terms(kind, refOut, exits, settings);
    if (t.minOut <= 0n) throw refuse('That exit\'s floor rounds to nothing; choose another.', 400);
    const nonce = crypto.randomBytes(8).readBigUInt64LE() >> 1n;
    const placed = await op.placeOrder({ program: cfg.program, owner, nonce, executor: cfg.executor, inputMint: token, outputMint: op.WSOL, outputNative: true, amountIn, minAmountOut: t.minOut, validUntil: Math.floor(validUntil / 1000) });
    orders.push({ kind, kind_name: KINDS[kind], nonce, order: placed.order, instruction: placed.instruction, amountIn, minOut: t.minOut, triggerOut: t.triggerOut, refOut, said: t.said });
  }
  const instructions = [
    ...await Promise.all(volumeVenues.map(venue => op.initVolume({ venue, payer: owner, user: transit }))),
    ...orders.map(o => o.instruction),
    op.approveChecked({ tokenProgram, source: tokenAta, mint: token, delegate, owner, amount: approveAmount, decimals }),
  ];
  const symbol = (await require('../providers/dexscreener').pairs('solana', [token]).catch(() => ({})))[token]?.symbol || short(token);
  const amountWhole = whole(amountIn, decimals);
  const first = o => worstCase({ kind: o.kind, amountWhole, symbol, minOut: o.minOut, validUntil })[0];
  return {
    instructions,
    tables: await ownTable(cfg.lookupTable), // the delegate and the exchanges' fixed accounts, at a byte each
    volumesWanted: missing.length > 0,
    // Left out to fit: the user's own one-time setup, a transaction of its own, signed just before the buy.
    ...(!volumes && missing.length ? { setup: await setupTransaction(cfg.program, owner, missing) } : {}),
    addresses: orders.map(o => o.order),
    orders: orders.map(({ instruction, ...o }) => ({ ...o, token, symbol, tokenProgram, decimals, source: tokenAta, program: cfg.program, executor: cfg.executor, validUntil })),
    summary: {
      orders: orders.map(o => ({ kind: o.kind, kind_name: o.kind_name, trigger_sol: sol(o.triggerOut), floor_sol: sol(o.minOut), ...o.said })),
      covers: `the ${fmt(amountWhole)} ${symbol} this buy is sure to bring (its minimum); anything it brings above that isn't covered`,
      worst_case: [
        ...orders.map(first),
        'Nothing else of yours can be touched: the approval covers only these coins, and the order program sends what they sell for only to your wallet. RektBull never holds them.',
        ...(orders.length > 1 ? ['The two orders sell the same coins: once one has sold them, cancel the other on the Trade desk to get its deposit back.'] : []),
        'To stop them: cancel them on the Trade desk (their deposits come back), or revoke the approval in your wallet.',
      ],
      costs: {
        order_deposits_sol: sol(ORDER_RENT * BigInt(orders.length)), order_deposits_note: 'Held by the order accounts and returned to you when they are filled or cancelled.',
        ...(missing.length ? { volume_accounts_sol: sol(VOLUME_RENT * BigInt(missing.length)), volume_accounts_note: volumes ? 'Once per wallet: the volume accounts pump.fun and PumpSwap need for your order address.' : 'Once per wallet: the volume accounts pump.fun and PumpSwap need for your order address. They don\'t fit in the buy\'s transaction, so your wallet signs them first, in a small setup transaction of their own.' } : {}),
        fee: 'RektBull\'s 1% of the SOL an exit brings, taken by the order program. Nothing if it never fills.',
      },
    },
  };
}

/** The user's one-time setup: pump.fun's and PumpSwap's volume accounts for their order address, paid by them. */
async function setupTransaction(program, owner, venues) {
  const transit = await op.transitOf(program, owner);
  const instructions = await Promise.all(venues.map(venue => op.initVolume({ venue, payer: owner, user: transit })));
  const bh = await latestBlockhash();
  const c = otx.compile({ payer: owner, instructions, ...bh });
  return { transaction: c.transaction, last_valid_block_height: bh.lastValidBlockHeight, bytes: c.bytes, sol: sol(VOLUME_RENT * BigInt(venues.length)) };
}

/** For the card: the one-time setup's transaction when the user's order address still lacks a volume account, else { needed: [] }. */
async function setup(account) {
  const cfg = await ready();
  const owner = account.solana_wallet;
  if (!owner) throw refuse('Link a Solana wallet to your account first.', 409);
  const transit = await op.transitOf(cfg.program, owner);
  const venues = [op.P.pumpFun, op.P.pumpAmm];
  const there = await accounts(await Promise.all(venues.map(v => op.volumeOf(v, transit))));
  const needed = venues.filter((_, i) => !there[i]);
  if (!needed.length) return { needed: [] };
  return { needed, solana: await setupTransaction(cfg.program, owner, needed) };
}

/** The trade was made with exits: their rows, prepared until the transaction lands (reconcile opens them). */
async function recordExits(accountId, orders = []) {
  for (const o of orders || []) {
    await db.query(
      `INSERT INTO solana_orders (account_id, owner, order_address, program, nonce, kind, token, symbol, token_program, decimals, source, amount_in, min_out, trigger_out, ref_out, executor, valid_until)
       SELECT $1, owner, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16 FROM (SELECT solana_wallet AS owner FROM accounts WHERE id = $1) a
       ON CONFLICT (order_address) DO NOTHING`,
      [accountId, o.order, o.program, String(o.nonce), o.kind, o.token, o.symbol, o.tokenProgram, o.decimals, o.source, String(o.amountIn), String(o.minOut), o.triggerOut === null ? null : String(o.triggerOut), String(o.refOut), o.executor, new Date(o.validUntil)]);
  }
}

/** The user's wallet sent it: the order, read from the chain and compared with what was prepared. */
async function confirm(account, id) {
  const row = await own(account, id);
  if (row.state !== 'prepared') return view(row);
  const [acct] = await accounts([row.order_address]);
  if (!acct) return { ...view(row), waiting: true, message: 'Not on the chain yet. If your wallet sent it, check again in a few seconds.' };
  const o = acct.owner === row.program ? op.decodeOrder(dataOf(acct)) : null;
  if (!matches(o, row)) throw refuse('The order on the chain isn\'t the one RektBull prepared, so RektBull won\'t fill it. Cancel it from your wallet.', 409);
  const { rows: [done] } = await db.query(`UPDATE solana_orders SET state = 'open', updated_at = now() WHERE id = $1 AND state = 'prepared' RETURNING *`, [row.id]);
  return view(done || row);
}

const matches = (o, row) => !!o && o.owner === row.owner && o.executor === row.executor
  && (isBuy(row) ? o.inputMint === op.WSOL && o.outputMint === row.token && !o.outputNative : o.inputMint === row.token && o.outputMint === op.WSOL && o.outputNative)
  && o.amountIn === BigInt(row.amount_in) && o.minAmountOut === BigInt(row.min_out) && o.nonce === BigInt(row.nonce);

/** The transaction for the user's wallet to cancel: the order closed, and the approval revoked when it was the last on that account. */
async function cancel(account, id) {
  const row = await own(account, id);
  if (['filled', 'cancelled'].includes(row.state)) return { order: view(row), done: true };
  const [acct] = await accounts([row.order_address]);
  if (!acct) {
    if (row.state === 'prepared') { await db.query('DELETE FROM solana_orders WHERE id = $1', [row.id]); return { order: { ...view(row), state: 'cancelled' }, done: true }; }
    return { order: view(await settle(row)), done: true };
  }
  const { rows: others } = await db.query(`SELECT count(*)::int AS n FROM solana_orders WHERE account_id = $1 AND source = $2 AND id <> $3 AND state IN ('open', 'triggered')`, [account.id, row.source, row.id]);
  const last = !others[0].n;
  // A buy's approval is on the wrapped-SOL account; with the last buy cancelled, that account is closed back into SOL too.
  const instructions = otx.cancelInstructions({ program: row.program, owner: row.owner, order: row.order_address, revokeSource: last ? row.source : null, tokenProgram: isBuy(row) ? op.P.token : row.token_program, unwrap: isBuy(row) && last ? row.source : null });
  const bh = await latestBlockhash();
  const c = otx.compile({ payer: row.owner, instructions, ...bh });
  return { order: view(row), revokes_approval: last, unwraps_sol: isBuy(row) && last, solana: { transaction: c.transaction, last_valid_block_height: bh.lastValidBlockHeight, bytes: c.bytes } };
}

/** After the wallet sent a cancel (or any time): the order's state from the chain. */
async function refresh(account, id) {
  const row = await own(account, id);
  if (!['open', 'triggered', 'expired', 'prepared'].includes(row.state)) return view(row);
  const [acct] = await accounts([row.order_address]);
  if (acct) return view(row);
  return view(row.state === 'prepared' ? row : await settle(row));
}

/** An order whose account is gone: filled if its fills add up, else cancelled. */
async function settle(row) {
  const { rows: [f] } = await db.query(`SELECT count(*) FILTER (WHERE state = 'sent')::int AS sent FROM solana_order_fills WHERE order_id = $1`, [row.id]);
  if (f.sent) return row; // a fill may have closed it: confirmed first
  const state = BigInt(row.filled_in) >= BigInt(row.amount_in) ? 'filled' : 'cancelled';
  const { rows: [done] } = await db.query('UPDATE solana_orders SET state = $2, updated_at = now() WHERE id = $1 RETURNING *', [row.id, state]);
  return done;
}

async function own(account, id) {
  const { rows: [row] } = await db.query('SELECT * FROM solana_orders WHERE id = $1 AND account_id = $2', [Number(id) || 0, account.id]);
  if (!row) throw Object.assign(new Error('No such order.'), { status: 404 });
  return row;
}

/** The account's orders, newest first, with their fills. */
async function list(account) {
  const { rows } = await db.query(`SELECT * FROM solana_orders WHERE account_id = $1 AND state <> 'prepared' ORDER BY created_at DESC LIMIT 100`, [account.id]);
  const { rows: fills } = rows.length ? await db.query('SELECT * FROM solana_order_fills WHERE order_id = ANY($1::bigint[]) ORDER BY created_at', [rows.map(r => r.id)]) : { rows: [] };
  const cfg = config();
  return {
    enabled: !cfg.off, ...(cfg.off ? { why: cfg.off } : {}),
    setup_needed: rows.some(r => ['open', 'triggered'].includes(r.state) && String(r.last_error || '').startsWith(SETUP_ERROR)),
    orders: rows.map(r => ({ ...view(r), fills: fills.filter(f => f.order_id === r.id).map(f => ({
      signature: f.signature, state: f.state,
      ...(isBuy(r) ? { spent_sol: sol(f.amount_in), coins: f.delivered ? whole(f.delivered, r.decimals) : null } : { sold_whole: whole(f.amount_in, r.decimals), delivered_sol: f.delivered ? sol(f.delivered) : null }),
      fee_sol: f.fee ? sol(f.fee) : null, error: f.error, at: f.created_at, tx_url: `https://solscan.io/tx/${f.signature}`,
    })) })),
  };
}

function view(r) {
  const common = {
    id: Number(r.id), kind: r.kind, kind_name: KINDS[r.kind], side: isBuy(r) ? 'buy' : 'sell', state: r.state, token: r.token, symbol: r.symbol,
    valid_until: r.valid_until, triggered_at: r.triggered_at, trigger_reason: r.trigger_reason,
    last_error: r.last_error, order_address: r.order_address, order_url: `https://solscan.io/account/${r.order_address}`, created_at: r.created_at,
  };
  if (isBuy(r)) {
    return {
      ...common, spend_sol: sol(r.amount_in), spent_sol: sol(r.filled_in), spend_usd: r.spend_usd === null || r.spend_usd === undefined ? null : Number(r.spend_usd),
      min_coins: whole(r.min_out, r.decimals), trigger_coins: r.trigger_out ? whole(r.trigger_out, r.decimals) : null,
      coins_when_placed: whole(r.ref_out, r.decimals), bought_coins: whole(r.delivered, r.decimals),
    };
  }
  return {
    ...common, amount_whole: whole(r.amount_in, r.decimals), sold_whole: whole(r.filled_in, r.decimals),
    floor_sol: sol(r.min_out), trigger_sol: r.trigger_out ? sol(r.trigger_out) : null, value_when_placed_sol: sol(r.ref_out), delivered_sol: sol(r.delivered),
  };
}

/* ── Meme Watch ── */

/**
 * A critical Meme Watch signal for a coin on Solana (the stream's insider
 * sells, or the 6-hour check's): every open Meme Watch exit on it fires.
 * Called from the worker; the trade service fills them on its next pass.
 */
async function memeWatchSignal(mint, reason) {
  if (!env.databaseUrl || !isSolanaAddress(String(mint || ''))) return 0;
  const { rowCount } = await db.query(
    `UPDATE solana_orders SET state = 'triggered', triggered_at = now(), trigger_reason = $2, next_attempt_at = now(), updated_at = now()
      WHERE token = $1 AND kind = 'meme_watch_exit' AND state = 'open' AND valid_until > now()`,
    [mint, JSON.stringify({ ...reason, at: new Date().toISOString() })]);
  if (rowCount) logger.info('solana orders: Meme Watch exits fired', { mint, orders: rowCount });
  return rowCount;
}

/* ── The trade service's pass ── */

async function alert(row, severity, id, title, text, source = 'RektBull\'s order service') {
  await require('../services/myAgents').raise(row.account_id, [{
    kind: 'solana_order', severity, wallet: row.owner, dedupe: `solorder:${row.id}:${id}`, title: `${KINDS[row.kind]} on ${row.symbol || short(row.token)}: ${title}`.slice(0, 200),
    detail: { reasons: [{ text, source }], order_id: Number(row.id), token: { chain: 'solana', token: row.token } },
  }]).catch(err => logger.warn('solana orders: alert not raised', { order: row.id, error: err.message }));
}

/** Orders read back from the chain: placed, gone (filled or cancelled), filled in part, expired. */
async function reconcile() {
  const { rows } = await db.query(`SELECT * FROM solana_orders WHERE state IN ('prepared', 'open', 'triggered') AND (state <> 'prepared' OR created_at < now() - interval '20 seconds') ORDER BY id LIMIT 1000`);
  if (!rows.length) return;
  const accts = await accounts(rows.map(r => r.order_address));
  for (const [i, row] of rows.entries()) {
    const acct = accts[i];
    const o = acct && acct.owner === row.program ? op.decodeOrder(dataOf(acct)) : null;
    if (row.state === 'prepared') {
      if (matches(o, row)) await db.query(`UPDATE solana_orders SET state = 'open', updated_at = now() WHERE id = $1`, [row.id]);
      else if (!acct && Date.now() - new Date(row.created_at) > PREPARED_TTL_MS) await db.query(`DELETE FROM solana_orders WHERE id = $1 AND state = 'prepared'`, [row.id]);
      continue;
    }
    if (!acct) { await settle(row); continue; }
    if (o && o.filledIn !== BigInt(row.filled_in)) await db.query('UPDATE solana_orders SET filled_in = $2, updated_at = now() WHERE id = $1', [row.id, o.filledIn.toString()]);
    if (new Date(row.valid_until) < new Date()) {
      await db.query(`UPDATE solana_orders SET state = 'expired', updated_at = now() WHERE id = $1`, [row.id]);
      await alert(row, 'medium', 'expired', 'it has ended', `It reached its end date without filling. Cancel it on the Trade desk to get its ${sol(ORDER_RENT)} SOL deposit back.`);
    }
  }
}

/** Stop-losses, take-profits and limit buys whose trigger is reached, by DexScreener's price, marked to fill. */
async function triggers() {
  const { rows } = await db.query(`SELECT * FROM solana_orders WHERE state = 'open' AND kind IN ('stop_loss', 'take_profit', 'limit_buy') AND valid_until > now()`);
  if (!rows.length) return;
  const tokens = [...new Set(rows.map(r => r.token))];
  const [pairs, solUsd] = await Promise.all([
    cached(`solana:orders:prices:${crypto.createHash('sha1').update(tokens.join(',')).digest('hex')}`, 10, () => require('../providers/dexscreener').pairs('solana', tokens)),
    require('../providers/prices').usdPrice('coingecko:solana'),
  ]);
  for (const row of rows) {
    const p = pairs[row.token]?.price_usd;
    if (!(p > 0) || !(solUsd > 0)) continue;
    const left = BigInt(row.amount_in) - BigInt(row.filled_in);
    if (left <= 0n) continue;
    const trigger = BigInt(row.trigger_out) * left / BigInt(row.amount_in);
    if (isBuy(row)) {
      // What the SOL left would buy now (less the 1%), against the coins at the user's limit.
      const coins = BigInt(Math.floor(Number(otx.buySwapAmount(left)) / 1e9 * solUsd / p * 10 ** row.decimals));
      if (coins < trigger) continue;
      const reason = { price_usd: p, sol_usd: solUsd, coins_now: whole(coins, row.decimals), coins_at_limit: whole(trigger, row.decimals), source: 'DexScreener (the coin\'s most liquid pair) and DefiLlama (SOL)' };
      await db.query(`UPDATE solana_orders SET state = 'triggered', triggered_at = now(), trigger_reason = $2, next_attempt_at = now(), updated_at = now() WHERE id = $1 AND state = 'open'`, [row.id, JSON.stringify(reason)]);
      continue;
    }
    const value = BigInt(Math.floor(whole(left, row.decimals) * p / solUsd * 1e9));
    const fire = row.kind === 'stop_loss' ? value <= trigger : value >= trigger;
    if (!fire) continue;
    const reason = { price_usd: p, sol_usd: solUsd, value_sol: sol(value), trigger_sol: sol(trigger), source: 'DexScreener (the coin\'s most liquid pair) and DefiLlama (SOL)' };
    await db.query(`UPDATE solana_orders SET state = 'triggered', triggered_at = now(), trigger_reason = $2, next_attempt_at = now(), updated_at = now() WHERE id = $1 AND state = 'open'`, [row.id, JSON.stringify(reason)]);
  }
}

/** The fills sent earlier: confirmed (with what reached the user, from the program's event) or failed. */
async function confirmFills() {
  const { rows } = await db.query(`SELECT f.*, o.account_id, o.kind, o.symbol, o.token, o.owner, o.decimals, o.amount_in AS order_amount FROM solana_order_fills f JOIN solana_orders o ON o.id = f.order_id WHERE f.state = 'sent' ORDER BY f.id LIMIT 100`);
  if (!rows.length) return;
  const statuses = (await rpc.solanaRpc('getSignatureStatuses', [rows.map(r => r.signature), { searchTransactionHistory: false }]))?.value || [];
  const height = await rpc.solanaRpc('getBlockHeight', [{ commitment: 'confirmed' }]).catch(() => null);
  for (const [i, f] of rows.entries()) {
    const s = statuses[i];
    const failed = async (error, retryMs = RETRY_MS.failed) => {
      await db.query(`UPDATE solana_order_fills SET state = 'failed', error = $2 WHERE id = $1`, [f.id, String(error).slice(0, 500)]);
      await db.query(`UPDATE solana_orders SET last_error = $2, next_attempt_at = now() + make_interval(secs => $3), updated_at = now() WHERE id = $1`, [f.order_id, String(error).slice(0, 500), retryMs / 1000]);
    };
    if (!s) {
      if (height !== null && f.last_valid_block_height && Number(height) > Number(f.last_valid_block_height)) await failed('it didn\'t land before its blockhash expired');
      else if (f.sent_via === 'jito' && !f.public_at && f.raw_tx && Date.now() - new Date(f.created_at).getTime() > privateSend.graceMs()) {
        // Not landed through Jito: the same signed transaction (same signature, so it can only land once) the usual way.
        await db.query(`UPDATE solana_order_fills SET public_at = now() WHERE id = $1`, [f.id]);
        await rpc.solanaRpc('sendTransaction', [f.raw_tx, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }])
          .then(() => logger.warn('solana orders: a fill hadn\'t landed through Jito; sent the usual way too', { order: f.order_id, signature: f.signature }))
          .catch(err => logger.warn('solana orders: a fill not resent', { order: f.order_id, error: err.message }));
      }
      continue;
    }
    if (s.err) {
      const t = await rpc.solanaRpc('getTransaction', [f.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
      await failed(`it failed onchain${why(t?.meta?.logMessages) ? `: ${why(t.meta.logMessages)}` : ` (${JSON.stringify(s.err)})`}`);
      continue;
    }
    if (!['confirmed', 'finalized'].includes(s.confirmationStatus)) continue;
    const t = await rpc.solanaRpc('getTransaction', [f.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    if (!t) continue;
    const ev = op.filledEvents(t.meta?.logMessages).find(e => e.owner === f.owner) || null;
    const amount = ev ? ev.amountIn : BigInt(f.amount_in);
    await db.query(`UPDATE solana_order_fills SET state = 'confirmed', delivered = $2, fee = $3, confirmed_at = now() WHERE id = $1`, [f.id, ev?.delivered?.toString() ?? null, ev?.fee?.toString() ?? null]);
    const { rows: [o] } = await db.query(
      `UPDATE solana_orders SET filled_in = LEAST(amount_in, filled_in + $2), delivered = delivered + $3, last_error = NULL, attempts = 0,
         state = CASE WHEN filled_in + $2 >= amount_in THEN 'filled' ELSE state END, updated_at = now() WHERE id = $1 RETURNING *`,
      [f.order_id, amount.toString(), (ev?.delivered ?? 0n).toString()]);
    const source = `Solana transaction ${f.signature.slice(0, 8)}…, the order program's Filled event`;
    if (isBuy(o)) {
      await alert(o, 'high', `fill:${f.signature}`, o.state === 'filled' ? 'bought' : 'bought in part',
        `Bought ${ev ? fmt(whole(ev.delivered, o.decimals)) : 'the'} ${o.symbol || 'coins'}, sent to your wallet, for about ${sol(otx.buySwapAmount(amount) + (ev?.fee ?? 0n))} SOL of your wrapped SOL${ev ? ` (RektBull's fee: ${sol(ev.fee)} SOL)` : ''}. What wasn't used stays in your wallet.`, source);
    } else {
      await alert(o, 'high', `fill:${f.signature}`, o.state === 'filled' ? 'sold' : 'sold in part',
        `Sold ${fmt(whole(amount, o.decimals))} ${o.symbol || 'coins'} for ${ev ? sol(ev.delivered) : 'the'} SOL, sent to your wallet${ev ? ` (RektBull's fee: ${sol(ev.fee)} SOL)` : ''}.`, source);
    }
  }
}

/** Jupiter's swap instruction alone (its setup and cleanup are for a wallet; the executor opens transit's accounts itself). */
const swapOnly = b => ({ ...b, computeBudgetInstructions: [], setupInstructions: [], cleanupInstruction: null, otherInstructions: [], tipInstruction: null });

/** The executor's priority price (micro-lamports a unit): the 75th percentile of what the swap's accounts paid lately, capped. */
async function priority(swap, units) {
  const writable = [...new Set(swap.accounts.filter(a => a.isWritable).map(a => a.pubkey))].slice(0, 128);
  const fees = ((await rpc.solanaRpc('getRecentPrioritizationFees', [writable]).catch(() => [])) || []).map(f => Number(f.prioritizationFee)).filter(f => f > 0).sort((a, b) => a - b);
  if (!fees.length) return 0;
  return Math.min(fees[Math.floor(fees.length * 0.75)], Number(PRIORITY_CAP_LAMPORTS * 1_000_000n / BigInt(units)));
}

/**
 * The Jito tip for a fill: { account, lamports }, or null when Jito's tip accounts can't be read (the fill is then sent
 * the usual way). A stop-loss or a Meme Watch exit tips what most bundles that landed lately paid; others the median.
 */
async function jitoTip(row) {
  try {
    const accounts = await privateSend.tipAccounts();
    return { account: accounts[crypto.randomInt(accounts.length)], lamports: await privateSend.tipLamports(row.kind === 'stop_loss' || row.kind === 'meme_watch_exit') };
  } catch (err) {
    logger.warn('solana orders: Jito\'s tip accounts not read; sending the usual way', { error: err.message });
    return null;
  }
}

/** One fill of a triggered order. Records what happened; throws only on a bug. */
async function attempt(row, cfg, exec) {
  const buy = isBuy(row);
  const TITLES = { below_floor: buy ? 'it can\'t fill at your limit' : 'it can\'t fill at your floor', nothing: buy ? 'it has no SOL to buy with' : 'it has nothing to sell', risk: 'RektBull\'s token check stopped it', setup: 'it needs a one-time setup from your wallet' };
  const later = async (error, ms, alertId = null, alertText = null) => {
    await db.query(`UPDATE solana_orders SET last_error = $2, last_attempt_at = now(), next_attempt_at = now() + make_interval(secs => $3), attempts = attempts + 1, updated_at = now() WHERE id = $1`, [row.id, error.slice(0, 500), ms / 1000]);
    if (alertId) await alert(row, 'high', alertId, TITLES[alertId], alertText);
  };
  const [delegate, transit] = await Promise.all([op.delegateOf(row.program), op.transitOf(row.program, row.owner)]);
  const [orderAcct, srcAcct] = await accounts([row.order_address, row.source]);
  const o = orderAcct ? op.decodeOrder(dataOf(orderAcct)) : null;
  if (!o) return; // closed: reconcile settles it
  const left = o.amountIn - o.filledIn;
  const src = tokenAccount(srcAcct);
  const approved = src && src.delegate === delegate ? src.delegatedAmount : 0n;
  let amount = left;
  if (src && src.amount < amount) amount = src.amount;
  if (approved < amount) amount = approved;
  if (!src || amount <= 0n) {
    const text = buy
      ? (!src || src.amount === 0n ? 'Your wallet\'s wrapped SOL for this buy is gone (unwrapped or spent).' : 'The approval for your wrapped SOL was revoked or used up.')
      : (!src || src.amount === 0n ? 'Your wallet no longer holds these coins.' : 'The approval for these coins was revoked or used up.');
    return later(`nothing to ${buy ? 'buy with' : 'sell'}: ${text}`, RETRY_MS.nothing, 'nothing', `${text} The order stays open until its end date; cancel it on the Trade desk to get its ${sol(ORDER_RENT)} SOL deposit back.`);
  }
  const minimum = op.minimumFor(o.minAmountOut, amount, o.amountIn);
  if (buy) {
    // The Trade desk's token check, run again before buying: a coin can turn bad after the order was placed.
    const risk = await require('../services/dueDiligence').quickCheck({ chain: 'solana', token: row.token }).catch(err => ({ incomplete: err.message }));
    if (risk.incomplete) return later(`the token check couldn't run (${risk.incomplete}): not buying until it can`, RETRY_MS.failed);
    if (risk.verdict === 'critical') {
      const flag = risk.flags.find(f => f.severity === 'critical');
      return later(`the token check found a critical risk: ${flag?.title}`, RETRY_MS.nothing, 'risk', `It fired, but RektBull's token check now finds a critical risk in ${row.symbol || 'this coin'}: ${flag?.title}. Nothing was bought. Cancel the order on the Trade desk to unwrap your SOL and get its deposit back.`);
    }
  }
  const pc = require('./pumpCurve');
  const name = row.symbol || 'coins';
  const belowText = (got, approx = '') => (buy
    ? `It fired, but ${sol(amount)} SOL would buy ${approx}${fmt(whole(got, row.decimals))} ${name}, fewer than your limit of ${fmt(whole(minimum, row.decimals))}, so the order program won't let it fill. It keeps trying while it's open.`
    : `It fired, but ${fmt(whole(amount, row.decimals))} ${name} would sell for ${approx}${sol(got)} SOL, below your floor of ${sol(minimum)} SOL after the fee, so the order program won't let it fill. It keeps trying while it's open; you can also sell from your own wallet on the Trade desk.`);

  /**
   * The route: straight on pump.fun's curve while the coin is on a SOL curve (no Jupiter in the path: pumpCurve.js),
   * else Jupiter. Each gives { swap, quotedOut, label, unwrapIn, wrappedOut, tables }, or null once `later` has said why not.
   */
  const direct = async curve => {
    if (buy) {
      const spend = pc.buySpend(amount);
      if (spend <= 0n) return undefined; // too small to leave pump.fun its headroom: Jupiter instead
      const swap = await pc.buySwap({ mint: row.token, tokenProgram: row.token_program, trader: transit, spend, minTokens: minimum });
      return { swap, quotedOut: curve.virtualToken * spend / (curve.virtualQuote + spend), label: swap.label, unwrapIn: true, wrappedOut: false, tables: {} };
    }
    // pump.fun's own check, at what leaves the user their price after RektBull's 1% (the program checks it again).
    const minSol = (minimum * 10000n + 9899n) / 9900n;
    const swap = await pc.sellSwap({ mint: row.token, tokenProgram: row.token_program, trader: transit, amount, minSol });
    return { swap, quotedOut: curve.virtualQuote * amount / (curve.virtualToken + amount), label: swap.label, unwrapIn: false, wrappedOut: false, tables: {} };
  };
  const viaJupiter = async () => {
    const swapAmount = buy ? otx.buySwapAmount(amount) : amount;
    const [inMint, outMint] = buy ? [op.WSOL, row.token] : [row.token, op.WSOL];
    let b;
    try {
      b = await jupiter.build({ inputMint: inMint, outputMint: outMint, amount: swapAmount, slippageBps: FILL_SLIPPAGE_BPS, taker: transit });
    } catch (err) {
      if (!err.isJupiter) throw err;
      await later(`no route: ${err.message}`, RETRY_MS.failed);
      return null;
    }
    let route;
    try {
      route = await require('./solana').checkInstructions(swapOnly(b), { wallet: transit, inputMint: inMint, outputMint: outMint, amount: swapAmount, slippageBps: FILL_SLIPPAGE_BPS });
      await require('./solana').checkLookupTables(b);
    } catch (err) {
      if (!err.isTradeBlocked) throw err;
      await later(err.message, RETRY_MS.failed);
      return null;
    }
    if (buy ? route.quotedOut < minimum : net(route.quotedOut) < minimum) {
      await later(buy ? `below the limit: ${fmt(whole(route.quotedOut, row.decimals))} coins quoted, ${fmt(whole(minimum, row.decimals))} needed`
        : `below the floor: ${sol(net(route.quotedOut))} SOL quoted after the fee, ${sol(minimum)} SOL needed`, RETRY_MS.below_floor, 'below_floor', belowText(buy ? route.quotedOut : net(route.quotedOut)));
      return null;
    }
    return {
      swap: b.swapInstruction, quotedOut: route.quotedOut, unwrapIn: false, wrappedOut: true,
      label: (b.routePlan || []).map(p => p.swapInfo?.label).filter(Boolean).join(' → ') || 'Jupiter', tables: b.addressesByLookupTableAddress || {},
    };
  };

  const curve = await pc.liveCurve(row.token).catch(err => { logger.warn('solana orders: pump.fun curve not read', { token: row.token, error: err.message }); return null; });
  const own = await ownTable(cfg.lookupTable);
  for (const kind of curve ? ['direct', 'jupiter'] : ['jupiter']) {
    const r = kind === 'direct' ? await direct(curve) : await viaJupiter();
    if (r === null) return; // `later` said why
    if (r === undefined) continue;
    // A pump.fun or PumpSwap volume account for the user's order address that the route uses but that doesn't exist
    // yet: the user's to open, once (the owner decided on 24 November 2026 that users pay for theirs). Nothing is sent
    // until they have; they're told, with the one-time setup on the Trade desk.
    const venues = [op.P.pumpFun, op.P.pumpAmm];
    const wanted = await Promise.all(venues.map(v => op.volumeOf(v, transit)));
    const used = wanted.map(a => r.swap.accounts.some(x => x.pubkey === a));
    const there = used.some(Boolean) ? await accounts(wanted) : [];
    if (venues.some((_, i) => used[i] && !there[i])) {
      return later(`${SETUP_ERROR}: pump.fun's volume account for your order address`, RETRY_MS.nothing, 'setup',
        `It fired, but this ${buy ? 'buy' : 'sale'} goes through pump.fun, which needs a volume account for your order address, opened once by your wallet (about ${sol(VOLUME_RENT)} SOL each). Open Orders on Solana on the Trade desk and press "Set up"; the order fills as soon as it's done.`);
    }
    const tables = { ...r.tables, ...own };
    // Jito (privateSend.js): a tip from the executor to one of Jito's tip accounts, in the fill itself, so it's paid
    // only if the fill lands. The tip account is never taken from a lookup table (Jito's rule).
    const tip = privateSend.jitoOn() ? await jitoTip(row) : null;
    const make = async (units, microLamports, withTip = false) => {
      const f = await otx.fillInstructions({ side: buy ? 'buy' : 'sell', program: row.program, executor: exec.address, owner: row.owner, order: row.order_address, token: row.token, tokenProgram: row.token_program, source: row.source, feeWallet: cfg.feeWallet, swap: r.swap, amountIn: amount, units, microLamports, unwrapIn: r.unwrapIn, wrappedOut: r.wrappedOut });
      const bh = await latestBlockhash();
      const instructions = withTip ? [...f.instructions, op.transfer({ from: exec.address, to: tip.account, lamports: tip.lamports })] : f.instructions;
      const lookups = withTip ? Object.fromEntries(Object.entries(tables).map(([t, list]) => [t, list.filter(a => a !== tip.account)])) : tables;
      return { ...bh, ...otx.compile({ payer: exec.address, instructions, ...bh, tables: lookups }), tipped: withTip };
    };
    const first = await make(CU_MAX, 0);
    if (first.bytes > otx.MAX_TX_BYTES) {
      if (kind === 'direct') continue;
      return later(`the fill is ${first.bytes} bytes, over Solana's ${otx.MAX_TX_BYTES}`, RETRY_MS.failed);
    }
    const sim = await simulate(first.transaction);
    if (sim.err) {
      const logs = why(sim.logs);
      // Below the user's price: pump.fun's own slippage check, or the order program's.
      if (/BelowLimit|TooLittleSolReceived|TooMuchSolRequired|slippage/i.test((sim.logs || []).join(' '))) {
        return later(`below the ${buy ? 'limit' : 'floor'} (${r.label}${logs ? `: ${logs}` : ''})`, RETRY_MS.below_floor, 'below_floor', belowText(r.quotedOut, kind === 'direct' ? 'about ' : ''));
      }
      if (kind === 'direct') { logger.warn('solana orders: a direct curve fill failed in simulation; trying Jupiter', { order: row.id, logs }); continue; }
      return later(`in a simulation the fill fails${logs ? `: ${logs}` : ` (${JSON.stringify(sim.err)})`}`, RETRY_MS.failed);
    }
    const units = Math.min(CU_MAX, Math.ceil(Math.max(sim.units, 100_000) * 1.2));
    const price = await priority(r.swap, units);
    let ready = await make(units, price, !!tip);
    // A tip that makes the fill too big for one transaction: sent the usual way, without it.
    if (ready.tipped && ready.bytes > otx.MAX_TX_BYTES) ready = await make(units, price, false);
    if (ready.bytes > otx.MAX_TX_BYTES) return later(`the fill is ${ready.bytes} bytes, over Solana's ${otx.MAX_TX_BYTES}`, RETRY_MS.failed);

    const signature = await exec.sign(ready.messageBytes, `solana_fill:${row.id}`);
    const sigText = b58encode(signature);
    const wire = otx.withSignature(ready.tx, exec.address, signature);
    // Recorded before it's sent, so a crash between the two can't lose track of it (one meant for Jito is sent the usual
    // way once its grace period is over, the same transaction).
    await db.query(`INSERT INTO solana_order_fills (order_id, signature, amount_in, quoted_out, route, last_valid_block_height, raw_tx, sent_via, tip) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [row.id, sigText, amount.toString(), r.quotedOut.toString(), r.label, ready.lastValidBlockHeight, wire, ready.tipped ? 'jito' : 'public', ready.tipped ? tip.lamports : null]);
    await db.query(`UPDATE solana_orders SET last_attempt_at = now(), attempts = attempts + 1, next_attempt_at = now() + interval '30 seconds', updated_at = now() WHERE id = $1`, [row.id]);
    if (ready.tipped) {
      if ((await privateSend.sendJito(wire)).ok) return;
      // Jito refused it: the usual way at once, since an exit must never wait on Jito.
      await db.query(`UPDATE solana_order_fills SET public_at = now() WHERE signature = $1`, [sigText]);
    }
    try {
      await rpc.solanaRpc('sendTransaction', [wire, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }]);
    } catch (err) {
      await db.query(`UPDATE solana_order_fills SET state = 'failed', error = $2 WHERE signature = $1`, [sigText, `not sent: ${err.message}`.slice(0, 500)]);
    }
    return;
  }
  return later('no route could fill it just now', RETRY_MS.failed);
}

/**
 * The trade service's pass (SERVICE_ROLE=trade), every TRADE_TICK_MS: orders
 * read back from the chain, sent fills confirmed, triggers checked, and the
 * fired orders filled (unless the emergency stop for automatic trading is on).
 */
async function tick() {
  const cfg = config();
  if (cfg.off || !env.databaseUrl) return { skipped: cfg.off || 'no database' };
  const p = await programCheck(cfg.program);
  if (!p.ok) return { skipped: p.why };
  await reconcile();
  await confirmFills();
  await triggers().catch(err => logger.warn('solana orders: prices not read', { error: err.message }));
  if (await require('../admin/stops').isStopped('auto_trading')) return { stopped: true };
  const { rows } = await db.query(
    `SELECT o.* FROM solana_orders o WHERE o.state = 'triggered' AND o.valid_until > now() AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())
       AND NOT EXISTS (SELECT 1 FROM solana_order_fills f WHERE f.order_id = o.id AND f.state = 'sent')
     ORDER BY o.triggered_at LIMIT $1`, [FILLS_PER_TICK]);
  if (!rows.length) return { filled: 0 };
  const exec = await require('./solanaExecutor').executor();
  if (exec.address !== cfg.executor) throw new Error('the executor key isn\'t the one orders name');
  for (const row of rows) {
    try { await attempt(row, cfg, exec); } catch (err) {
      logger.error('solana orders: a fill attempt failed', { order: row.id, error: err.message });
      await db.query(`UPDATE solana_orders SET last_error = $2, next_attempt_at = now() + interval '60 seconds', updated_at = now() WHERE id = $1`, [row.id, `RektBull's order service: ${err.message}`.slice(0, 500)]);
    }
  }
  return { attempted: rows.length };
}

module.exports = {
  KINDS, ORDER_RENT, VOLUME_RENT, FILL_SLIPPAGE_BPS,
  config, ready, programCheck, prepare, confirm, cancel, refresh, list, memeWatchSignal, tick, terms, worstCase, tokenAccount, exitsForBuy, recordExits, setup,
  _attempt: attempt, _reconcile: reconcile, _triggers: triggers, _confirmFills: confirmFills,
};

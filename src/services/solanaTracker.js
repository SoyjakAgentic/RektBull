/**
 * The Wallet Tracker on Solana (walletTracker.js does Base, Ethereum, Arbitrum
 * and BNB Chain): follow Solana wallets, and get an alert within seconds when
 * one buys or sells a token, with RektBull's token check (and, for a token
 * under a week old, the bundle check) already run and the buy ready on the
 * Trade desk for your own wallet to sign. Asked for by the owner on
 * 23 November 2026.
 *
 * How a trade is seen: the followed wallets ride the one Yellowstone
 * subscription (pumpStream.js) as filters of 200, ahead of Meme Watch's
 * insider wallets, which get the room left. Per transaction and followed
 * wallet, from the transaction's own balances before and after (its token
 * balances, its SOL balance, and its wrapped SOL, which Jupiter and others use
 * on the way):
 *
 *   - a token came in and the wallet paid for it (SOL, a stablecoin, or
 *     another token went out): a buy of what came in;
 *   - a token went out and something came back (SOL, a stablecoin, or another
 *     token): a sale of what went out;
 *   - a token only came in, or only went out: a transfer or an airdrop, not a
 *     trade;
 *   - SOL, wrapped SOL, USDC and USDT are what trades are paid in, not what is
 *     traded. The fee is added back when the wallet paid it, and SOL moves
 *     under 0.001 SOL don't count as a payment. What a buy paid includes the
 *     rent for a new token account (about 0.002 SOL), so it says "about".
 *
 * Following Solana wallets needs the stream (YELLOWSTONE_GRPC_URL): there's no
 * affordable way to poll them. Without it, following one is refused, saying so.
 */
const db = require('../config/db');
const logger = require('../config/logger');
const yellowstone = require('../providers/yellowstone');
const prices = require('../providers/prices');
const { cached } = require('../lib/cache');

const PREFIX = 'follow-';
const QUOTE = {
  So11111111111111111111111111111111111111112: { symbol: 'SOL', native: true },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', usd: 1 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', usd: 1 },
};
const MIN_SOL_LAMPORTS = 1000000n; // 0.001 SOL: less than this isn't a payment (fees, rent dust)
const ALERTS_PER_MINUTE = 60; // a wallet trading in bursts: the rest are recorded and shown, not alerted
const whole = (raw, decimals) => (decimals === null || decimals === undefined ? null : Number(raw) / 10 ** decimals);

/** The Solana wallets someone follows with the tracker's alerts on. */
async function walletsWatched() {
  if (require('../admin/agentStates').isOff('wallet_tracker')) return [];
  const { rows } = await db.query(
    `SELECT DISTINCT f.address FROM followed_wallets f
     LEFT JOIN agent_settings s ON s.account_id = f.account_id AND s.agent = 'wallet_tracker'
     WHERE f.family = 'solana' AND COALESCE(s.enabled, true) ORDER BY f.address`);
  return rows.map(r => r.address);
}

/**
 * The trades in one transaction (yellowstone.readTransaction) for the
 * followed wallets in `watched`: [{ wallet, side, token, amount_raw,
 * decimals, other: { native, symbol, amount } | { token, symbol, amount } }].
 */
function tradesIn(tx, watched) {
  if (tx.failed) return [];
  const out = [];
  const owners = new Set((tx.balances || []).map(b => b.owner).filter(o => watched.has(o)));
  for (const w of tx.keys) if (watched.has(w)) owners.add(w);
  for (const w of owners) {
    const tokens = new Map(); // mint -> { delta, decimals }
    for (const b of tx.balances || []) if (b.owner === w) tokens.set(b.mint, { delta: (tokens.get(b.mint)?.delta || 0n) + (b.post - b.pre), decimals: b.decimals ?? null });
    // SOL: the wallet's own balance and its wrapped SOL, with the fee added back when it paid it.
    const lam = (tx.lamports || []).find(x => x.address === w);
    let sol = (lam ? lam.post - lam.pre : 0n) + (tokens.get('So11111111111111111111111111111111111111112')?.delta || 0n);
    if (tx.keys[0] === w) sol += tx.fee || 0n;
    tokens.delete('So11111111111111111111111111111111111111112');
    const stables = [...tokens.entries()].filter(([m]) => QUOTE[m]);
    const traded = [...tokens.entries()].filter(([m, t]) => !QUOTE[m] && t.delta !== 0n);
    const ins = traded.filter(([, t]) => t.delta > 0n);
    const outs = traded.filter(([, t]) => t.delta < 0n);
    const paid = sol <= -MIN_SOL_LAMPORTS ? { native: true, symbol: 'SOL', amount: whole(-sol, 9) }
      : stables.filter(([, t]) => t.delta < 0n).map(([m, t]) => ({ token: m, symbol: QUOTE[m].symbol, amount: whole(-t.delta, t.decimals) }))[0]
      || (outs[0] ? { token: outs[0][0], symbol: null, amount: whole(-outs[0][1].delta, outs[0][1].decimals) } : null);
    const got = sol >= MIN_SOL_LAMPORTS ? { native: true, symbol: 'SOL', amount: whole(sol, 9) }
      : stables.filter(([, t]) => t.delta > 0n).map(([m, t]) => ({ token: m, symbol: QUOTE[m].symbol, amount: whole(t.delta, t.decimals) }))[0]
      || (ins[0] ? { token: ins[0][0], symbol: null, amount: whole(ins[0][1].delta, ins[0][1].decimals) } : null);
    for (const [m, t] of ins) if (paid && paid.token !== m) out.push({ wallet: w, side: 'buy', token: m, amount_raw: t.delta, decimals: t.decimals, other: paid });
    for (const [m, t] of outs) if (got && got.token !== m) out.push({ wallet: w, side: 'sell', token: m, amount_raw: -t.delta, decimals: t.decimals, other: got });
  }
  return out;
}

/** Symbols from DexScreener (30 a call), kept a day; a token with none shows its address. */
async function symbols(mints) {
  const out = {};
  const missing = [];
  const cache = require('../lib/cache');
  for (const m of [...new Set(mints)]) {
    const got = await cache.get(`tracker:sol:sym:${m}`).catch(() => null);
    if (got) out[m] = got; else missing.push(m);
  }
  if (missing.length) {
    const found = await require('../providers/dexscreener').pairs('solana', missing.slice(0, 30)).catch(() => ({}));
    for (const [m, p] of Object.entries(found)) if (p.symbol) { out[m] = p.symbol; await cache.set(`tracker:sol:sym:${m}`, p.symbol, 86400); }
  }
  return out;
}

/** About how much it was worth: what was paid or received, priced (SOL from DefiLlama; a stablecoin at $1). */
async function worth(t) {
  if (QUOTE[t.other.token]?.usd && t.other.amount !== null) return Math.round(t.other.amount * 100) / 100;
  if (t.other.native && t.other.amount !== null) {
    const p = await cached('tracker:sol:price', 60, () => prices.usdPrice('coingecko:solana')).catch(() => null);
    return p ? Math.round(t.other.amount * p * 100) / 100 : null;
  }
  return null;
}

/* ── on the stream ── */

let watched = new Set();
let summary = { wallets: 0, watched: 0, overflow: 0 };
const window = { at: 0, sent: 0 };
let chain = Promise.resolve();

/** The followed wallets' filters, at most `room` of 200 each; the set the stream's transactions are read for. */
async function prepare(room) {
  const wallets = await walletsWatched();
  const per = yellowstone.MAX_ACCOUNTS;
  const filters = {};
  for (let i = 0; i < wallets.length && i / per < room; i += per) filters[`${PREFIX}${i / per}`] = { accountInclude: wallets.slice(i, i + per) };
  const fit = wallets.slice(0, room * per);
  watched = new Set(fit);
  summary = { wallets: wallets.length, watched: fit.length, overflow: wallets.length - fit.length };
  if (summary.overflow) logger.warn('solana tracker: more followed wallets than the stream takes', { overflow: summary.overflow });
  return { filters, ...summary };
}

/** Records one trade and alerts its followers (within ALERTS_PER_MINUTE). */
async function handle(tx, t) {
  const wt = require('./walletTracker');
  const sym = (await symbols([t.token, ...(t.other.token && !QUOTE[t.other.token] ? [t.other.token] : [])]));
  const d = {
    chain: 'solana', wallet: t.wallet, tx: tx.signature, block: tx.slot ? Number(tx.slot) : 0, side: t.side, token: t.token, symbol: sym[t.token] || null,
    amount_whole: whole(t.amount_raw, t.decimals), other: { ...t.other, symbol: t.other.symbol || sym[t.other.token] || null }, usd: await worth(t),
  };
  const { rows } = await db.query(
    `INSERT INTO wallet_trades (chain, wallet, tx_hash, block, side, token, symbol, amount, other, usd)
     VALUES ('solana', $1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (chain, tx_hash, wallet, token, side) DO NOTHING RETURNING id`,
    [d.wallet, d.tx, d.block, d.side, d.token, d.symbol, d.amount_whole, JSON.stringify(d.other), d.usd]);
  if (!rows.length) return 0; // seen already
  if (d.side === 'sell') await wt.copySold(d); // the copies' stop-losses that sell with this wallet, alerted or not
  const now = Date.now();
  if (now - window.at > 60000) { window.at = now; window.sent = 0; }
  if (window.sent >= ALERTS_PER_MINUTE) { logger.warn('solana tracker: too many trades at once; recorded, not alerted', { wallet: d.wallet }); return 0; }
  window.sent++;
  const checks = d.side === 'buy' ? await wt.checksFor('solana', d.token) : null;
  const { rows: followers } = await db.query(
    `SELECT f.account_id, f.label, f.copy_usd, f.copy_stop_pct, f.copy_take_pct, f.copy_sell_with FROM followed_wallets f
     LEFT JOIN agent_settings s ON s.account_id = f.account_id AND s.agent = 'wallet_tracker'
     WHERE f.address = $1 AND COALESCE(s.enabled, true)`, [d.wallet]);
  let n = 0;
  for (const f of followers) n += await require('./myAgents').raise(f.account_id, [wt.alertFor(d, f, checks)]);
  return n;
}

/** One transaction from the stream: the followed wallets' trades in it, handled one at a time, in order. */
function onTransaction(tx) {
  if (!watched.size) return;
  const trades = tradesIn(tx, watched);
  for (const t of trades) chain = chain.then(() => handle(tx, t)).catch(err => logger.warn('solana tracker: a trade could not be handled', { tx: tx.signature, error: err.message }));
}

module.exports = { PREFIX, QUOTE, MIN_SOL_LAMPORTS, walletsWatched, tradesIn, prepare, onTransaction, handle, summary: () => summary, _drain: () => chain, _set: w => { watched = new Set(w); } };

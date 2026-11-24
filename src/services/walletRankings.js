/**
 * Wallets ranked by realised profit (the Wallet Tracker's next part, asked
 * for by the owner on 24 November 2026): "smart money" worth following,
 * found by stated rules instead of brought by the user.
 *
 * The source: every buy and sell on pump.fun's bonding curves, from the
 * Yellowstone stream RektBull already reads (pumpStream.js), so it costs no
 * extra data. Each trade event says the wallet, the coin, the SOL and tokens
 * moved, pump.fun's fee and the creator's fee, and the coin's creator.
 *
 * The rules (RULES), in the worker that streams:
 *   - A position is a wallet's holding of one coin, bought on the curve while
 *     RektBull watched. What it cost includes pump.fun's and the creator's
 *     fees; what a sale brings is after them.
 *   - A sale realises profit on the part of the position RektBull saw bought,
 *     at its average cost. Coins the wallet had before (bought elsewhere, or
 *     before the stream started) aren't counted.
 *   - A coin counts as closed when 99% of what was bought is sold: a win if
 *     the position made money, a loss if not.
 *   - Left out: a coin's creator trading it; positions that started with a buy
 *     under 0.05 SOL; buys within 2 seconds of the coin's creation (snipes,
 *     counted apart); positions still open after 7 days, or whose coin left the
 *     curve (sales on PumpSwap aren't on this stream yet).
 *   - Ranked: wallets with at least 5 coins closed in the window and a profit,
 *     by realised SOL. Left out: a wallet with over 500 trades in any day of the
 *     window (a bot), or with more snipes than counted coins.
 *
 * What's kept: per wallet and day, the sums (wallet_pnl_daily), written every
 * minute; open positions stay in the worker's memory (at most MAX_POSITIONS,
 * the least recent dropped first). Public onchain facts about wallets, not
 * about RektBull's users; deleted after 35 days.
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const { cached } = require('../lib/cache');

const LAMPORTS = 1e9;
const RULES = {
  min_first_buy_lamports: 0.05 * LAMPORTS,
  snipe_seconds: 2,
  closed_share: 0.99,
  open_days: 7,
  min_coins: 5,
  bot_trades_per_day: 500,
};
const FLUSH_MS = 60_000;
const MAX_POSITIONS = 400_000;
const MAX_CREATES = 50_000;
const WINDOWS = { '7d': 7, '30d': 30 };
const TOP = 50;

let positions = new Map(); // `${wallet}:${mint}` -> { b, c, s, p, r, at, snipe }
let days = new Map(); // `${wallet}|${day}` -> sums written at the next flush
let trades = new Map(); // wallet -> trades today (bot detection), reset each UTC day
let tradesDay = null;
let creates = new Map(); // mint -> creation time (s), for the snipe rule

function reset() {
  positions = new Map(); days = new Map(); trades = new Map(); creates = new Map(); tradesDay = null;
}

const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
function sums(wallet, day) {
  const k = `${wallet}|${day}`;
  let d = days.get(k);
  if (!d) { d = { wallet, day, realised: 0, cost: 0, proceeds: 0, coins: 0, wins: 0, losses: 0, snipes: 0, best: 0 }; days.set(k, d); }
  return d;
}
/** Moves a key to the end of a Map (the most recently used), so the oldest is first to go. */
const touch = (map, k, v) => { map.delete(k); map.set(k, v); };

/**
 * One pump.fun event (pumpStream.decodeEvent), SOL-quoted only. Pure memory:
 * the database is only touched by flush().
 */
function onEvent(e, now = Date.now()) {
  if (e.quote_mint !== undefined && !['So11111111111111111111111111111111111111112', '11111111111111111111111111111111'].includes(e.quote_mint)) return;
  if (e.type === 'create') {
    touch(creates, e.mint, e.timestamp);
    while (creates.size > MAX_CREATES) creates.delete(creates.keys().next().value);
    return;
  }
  if (e.type === 'complete' || e.type === 'migrate') {
    // The coin left the curve: its open positions can't close here any more (PumpSwap isn't on the stream).
    for (const k of positions.keys()) if (k.endsWith(`:${e.mint}`)) positions.delete(k);
    return;
  }
  if (e.type !== 'trade') return;
  const at = e.timestamp > 0 ? e.timestamp * 1000 : now;
  const day = dayOf(at);
  if (day !== tradesDay) { trades = new Map(); tradesDay = day; }
  trades.set(e.user, (trades.get(e.user) || 0) + 1);
  if (e.creator && e.user === e.creator) return; // a coin's creator trading their own coin
  const fees = Number(e.fee || 0n) + Number(e.creator_fee || 0n);
  const sol = Number(e.sol_amount);
  const tokens = Number(e.token_amount);
  if (!(tokens > 0)) return;
  const k = `${e.user}:${e.mint}`;
  let pos = positions.get(k);
  if (e.is_buy) {
    const cost = sol + fees;
    if (!pos) {
      if (cost < RULES.min_first_buy_lamports) return;
      const born = creates.get(e.mint);
      pos = { b: 0, c: 0, s: 0, p: 0, r: 0, at, snipe: born !== undefined && e.timestamp - born <= RULES.snipe_seconds };
    }
    pos.b += tokens; pos.c += cost; pos.at = at;
    touch(positions, k, pos);
    while (positions.size > MAX_POSITIONS) positions.delete(positions.keys().next().value);
    return;
  }
  if (!pos) return; // a sale of coins RektBull didn't see bought
  const covered = Math.min(tokens, pos.b - pos.s);
  if (covered <= 0) return;
  const proceeds = Math.max(0, sol - fees) * covered / tokens;
  const costPart = pos.c * covered / pos.b;
  pos.s += covered; pos.p += proceeds; pos.r += proceeds - costPart; pos.at = at;
  const d = sums(e.user, day);
  if (!pos.snipe) { d.realised += proceeds - costPart; d.cost += costPart; d.proceeds += proceeds; }
  if (pos.s >= pos.b * RULES.closed_share) {
    positions.delete(k);
    if (pos.snipe) d.snipes += 1;
    else {
      d.coins += 1;
      if (pos.r > 0) d.wins += 1; else d.losses += 1;
      if (pos.r > d.best) d.best = pos.r;
    }
  } else touch(positions, k, pos);
}

/** Positions still open after RULES.open_days are dropped (never realised). */
function prune(now = Date.now()) {
  const cut = now - RULES.open_days * 86400_000;
  for (const [k, p] of positions) { if (p.at >= cut) break; positions.delete(k); } // oldest first
}

/** Writes the day sums gathered since the last flush (one statement), and prunes. */
async function flush(now = Date.now()) {
  prune(now);
  if (!days.size || !env.databaseUrl) return 0;
  const rows = [...days.values()];
  days = new Map();
  const col = f => rows.map(f);
  const L = x => Math.round(x);
  await db.query(
    `INSERT INTO wallet_pnl_daily (chain, wallet, day, realised, cost, proceeds, coins, wins, losses, snipes, best, trades, bot)
     SELECT 'solana', w, d::date, r, c, p, n, wi, lo, sn, be, t, t > $12
       FROM unnest($1::text[], $2::text[], $3::bigint[], $4::bigint[], $5::bigint[], $6::int[], $7::int[], $8::int[], $9::int[], $10::bigint[], $11::int[])
         AS x(w, d, r, c, p, n, wi, lo, sn, be, t)
     ON CONFLICT (chain, wallet, day) DO UPDATE SET
       realised = wallet_pnl_daily.realised + EXCLUDED.realised, cost = wallet_pnl_daily.cost + EXCLUDED.cost,
       proceeds = wallet_pnl_daily.proceeds + EXCLUDED.proceeds, coins = wallet_pnl_daily.coins + EXCLUDED.coins,
       wins = wallet_pnl_daily.wins + EXCLUDED.wins, losses = wallet_pnl_daily.losses + EXCLUDED.losses,
       snipes = wallet_pnl_daily.snipes + EXCLUDED.snipes, best = GREATEST(wallet_pnl_daily.best, EXCLUDED.best),
       trades = GREATEST(wallet_pnl_daily.trades, EXCLUDED.trades), bot = wallet_pnl_daily.bot OR EXCLUDED.bot, updated_at = now()`,
    [col(r => r.wallet), col(r => r.day), col(r => L(r.realised)), col(r => L(r.cost)), col(r => L(r.proceeds)), col(r => r.coins), col(r => r.wins), col(r => r.losses), col(r => r.snipes), col(r => L(r.best)),
      col(r => (r.day === tradesDay ? trades.get(r.wallet) || 0 : 0)), RULES.bot_trades_per_day],
  );
  return rows.length;
}

/* ── The ranking (web role) ── */

const sol = l => Math.round(Number(l) / LAMPORTS * 1000) / 1000;

/**
 * The top wallets by realised profit over a window ('7d' or '30d'), kept five
 * minutes: { window, rules, wallets: [...], source }.
 */
async function top(windowName = '7d') {
  const w = WINDOWS[windowName] ? windowName : '7d';
  return cached(`wallets:top:solana:${w}`, 300, async () => {
    const { rows } = await db.query(
      `SELECT wallet, sum(realised)::bigint AS realised, sum(cost)::bigint AS cost, sum(coins)::int AS coins, sum(wins)::int AS wins, sum(losses)::int AS losses,
              sum(snipes)::int AS snipes, max(best)::bigint AS best, max(day) AS last_day
         FROM wallet_pnl_daily
        WHERE chain = 'solana' AND day > current_date - $1::int
        GROUP BY wallet
       HAVING sum(coins) >= $2 AND NOT bool_or(bot) AND sum(snipes) <= sum(coins) AND sum(realised) > 0
        ORDER BY sum(realised) DESC LIMIT $3`,
      [WINDOWS[w], RULES.min_coins, TOP]);
    const solUsd = await require('../providers/prices').usdPrice('coingecko:solana').catch(() => null);
    const { rows: [since] } = await db.query(`SELECT min(day) AS first FROM wallet_pnl_daily WHERE chain = 'solana'`);
    return {
      window: w, days: WINDOWS[w], counted_since: since?.first || null, sol_usd: solUsd,
      stream: require('../providers/yellowstone').configured(), // without it nothing is counted
      rules: describe(),
      source: 'Every buy and sell on pump.fun\'s bonding curves, read from the chain as it confirms them (Yellowstone gRPC); SOL\'s price from DefiLlama',
      wallets: rows.map((r, i) => ({
        rank: i + 1, wallet: r.wallet,
        realised_sol: sol(r.realised), realised_usd: solUsd ? Math.round(Number(r.realised) / LAMPORTS * solUsd) : null,
        return_pct: Number(r.cost) > 0 ? Math.round(Number(r.realised) / Number(r.cost) * 1000) / 10 : null,
        coins: r.coins, wins: r.wins, losses: r.losses, win_rate_pct: r.coins ? Math.round(r.wins / r.coins * 100) : null,
        best_coin_sol: sol(r.best), best_share_pct: Number(r.realised) > 0 ? Math.min(100, Math.round(Number(r.best) / Number(r.realised) * 100)) : null,
        snipes: r.snipes, last_active: r.last_day,
        solscan: `https://solscan.io/account/${r.wallet}`,
      })),
    };
  });
}

/** The rules in plain words, shown with the ranking. */
function describe() {
  return [
    'Realised profit only: SOL a wallet got back from selling a coin, less what that part cost, after pump.fun\'s and the creator\'s fees. Coins still held don\'t count.',
    'Only trades on pump.fun\'s bonding curves that RektBull saw: a coin bought before, or sold after it moved to PumpSwap, isn\'t counted.',
    `A coin counts once ${Math.round(RULES.closed_share * 100)}% of what was bought is sold; a position still open after ${RULES.open_days} days is dropped.`,
    `Left out: a coin's creator trading it; positions that started under ${RULES.min_first_buy_lamports / LAMPORTS} SOL; buys within ${RULES.snipe_seconds} seconds of a coin's creation (snipes, shown apart).`,
    `Ranked: at least ${RULES.min_coins} coins closed in the window, and a profit. Left out: wallets with over ${RULES.bot_trades_per_day} trades in a day (bots), or more snipes than counted coins.`,
    'Past profit says nothing sure about the next trade: copying a wallet buys after it, at a worse price.',
  ];
}

module.exports = { RULES, FLUSH_MS, WINDOWS, onEvent, flush, prune, reset, top, describe, _state: () => ({ positions, days, trades, creates }) };

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
 *   - Once a coin leaves the curve for PumpSwap, its open positions follow it
 *     there: the stream adds the pool (from pump.fun's migration event) to a
 *     filter of its own, at most RULES.max_amm_pools pools, those graduated
 *     last first, and only while a position on the coin is open. A sale on
 *     PumpSwap realises profit the same way, at what the user got after every
 *     fee; a buy there adds to a position already open, never starts one.
 *   - Left out: a coin's creator trading it; positions that started with a buy
 *     under 0.05 SOL; buys within 2 seconds of the coin's creation (snipes,
 *     counted apart); positions still open after 7 days, or on a coin whose
 *     pool didn't fit in the filter (dropped).
 *   - Ranked: wallets with at least 5 coins closed in the window and a profit,
 *     by realised SOL. Left out: a wallet with over 500 trades in any day of the
 *     window (a bot), or with more snipes than counted coins.
 *
 * What's kept: per wallet and day, the sums (wallet_pnl_daily), written every
 * minute; open positions stay in the worker's memory (at most MAX_POSITIONS,
 * the least recent dropped first). Public onchain facts about wallets, not
 * about RektBull's users; deleted after 35 days.
 *
 * BNB Chain (added 25 November 2026, the owner's option A): the same rules on
 * four.meme's bonding curves, from the trade service's WebSocket stream
 * (trade/memeStream.js), under a daily budget of its own (`rankings_daily_budget`,
 * 50,000 events: docs/COST_LIMITS.md). One ranker per chain (forChain): BNB
 * amounts are kept in gwei, nine decimals like lamports. The functions exported
 * at the top level are Solana's, as before.
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const { cached } = require('../lib/cache');

const LAMPORTS = 1e9; // and gwei: nine decimals for SOL and BNB alike
// Each chain's coin, launchpad, explorer and price; and where its trades come from.
const CHAINS = {
  solana: { unit: 'SOL', min_first_buy: 0.05 * LAMPORTS, priceId: 'coingecko:solana', explorer: 'https://solscan.io/account/', venue: 'pump.fun',
    source: 'Every buy and sell on pump.fun\'s bonding curves, and on PumpSwap once a coin moves there, read from the chain as it confirms them (Yellowstone gRPC); SOL\'s price from DefiLlama' },
  bsc: { unit: 'BNB', min_first_buy: 0.01 * LAMPORTS, priceId: 'coingecko:binancecoin', explorer: 'https://bscscan.com/address/', venue: 'four.meme',
    source: 'Every buy and sell on four.meme\'s bonding curves (BNB-quoted coins), read from TokenManager2\'s TokenPurchase and TokenSale events as BNB Chain pushes them (WebSocket), within a daily budget; BNB\'s price from DefiLlama' },
};
const RULES = {
  min_first_buy_lamports: 0.05 * LAMPORTS, // Solana's; each chain's is CHAINS[chain].min_first_buy
  snipe_seconds: 2,
  closed_share: 0.99,
  open_days: 7,
  min_coins: 5,
  bot_trades_per_day: 500,
  max_amm_pools: 200, // PumpSwap pools followed on the stream at once
};
const FLUSH_MS = 60_000;
const MAX_POSITIONS = 400_000;
const MAX_CREATES = 50_000;
const WINDOWS = { '7d': 7, '30d': 30 };
const TOP = 50;

const MAX_AMM_KNOWN = 5000;
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
/** Moves a key to the end of a Map (the most recently used), so the oldest is first to go. */
const touch = (map, k, v) => { map.delete(k); map.set(k, v); };

/** One chain's ranker: its own positions, day sums and counts, in the memory of the process that streams it. */
function createRanker(chain) {
const minFirstBuy = CHAINS[chain].min_first_buy;
let creators = new Map(); // mint -> its creator, where a creation event names it apart from the trades (four.meme)
let positions = new Map(); // `${wallet}:${mint}` -> { b, c, s, p, r, at, snipe }
let days = new Map(); // `${wallet}|${day}` -> sums written at the next flush
let trades = new Map(); // wallet -> trades today (bot detection), reset each UTC day
let tradesDay = null;
let creates = new Map(); // mint -> creation time (s), for the snipe rule
let amm = new Map(); // PumpSwap pool -> { mint, at }: graduated coins, the most recent last
let ammOverflow = 0;

function reset() {
  positions = new Map(); days = new Map(); trades = new Map(); creates = new Map(); creators = new Map(); amm = new Map(); tradesDay = null; ammOverflow = 0;
}

function sums(wallet, day) {
  const k = `${wallet}|${day}`;
  let d = days.get(k);
  if (!d) { d = { wallet, day, realised: 0, cost: 0, proceeds: 0, coins: 0, wins: 0, losses: 0, snipes: 0, best: 0 }; days.set(k, d); }
  return d;
}
/**
 * One trade event: pump.fun's (pumpStream.decodeEvent, SOL-quoted only), or four.meme's as the stream gives it
 * ({ type: 'create', mint, creator } and { type: 'trade', … } in gwei, BNB-quoted only). Pure memory:
 * the database is only touched by flush().
 */
function onEvent(e, now = Date.now()) {
  if (e.quote_mint !== undefined && !['So11111111111111111111111111111111111111112', '11111111111111111111111111111111'].includes(e.quote_mint)) return;
  if (e.type === 'create') {
    touch(creates, e.mint, e.timestamp);
    while (creates.size > MAX_CREATES) creates.delete(creates.keys().next().value);
    if (e.creator) { touch(creators, e.mint, e.creator); while (creators.size > MAX_CREATES) creators.delete(creators.keys().next().value); }
    return;
  }
  if (e.type === 'complete') return; // the curve is full: its migration to PumpSwap follows
  if (e.type === 'migrate') {
    // The coin moved to PumpSwap: its pool is followed (pools()), so open positions can still close there.
    if (e.pool) { touch(amm, e.pool, { mint: e.mint, at: e.timestamp > 0 ? e.timestamp * 1000 : now }); while (amm.size > MAX_AMM_KNOWN) amm.delete(amm.keys().next().value); }
    return;
  }
  if (e.type === 'swap') {
    // A PumpSwap trade, in a pool of a coin that left the curve, as a curve trade: what the user paid or got has every fee in it.
    const g = amm.get(e.pool);
    if (!g) return;
    if (e.is_buy && !positions.has(`${e.user}:${g.mint}`)) return; // PumpSwap adds to positions; it never starts one
    e = { type: 'trade', mint: g.mint, sol_amount: e.quote_amount, token_amount: e.base_amount, is_buy: e.is_buy, user: e.user, timestamp: e.timestamp, creator: e.coin_creator, net: true };
  }
  if (e.type !== 'trade') return;
  const at = e.timestamp > 0 ? e.timestamp * 1000 : now;
  const day = dayOf(at);
  if (day !== tradesDay) { trades = new Map(); tradesDay = day; }
  trades.set(e.user, (trades.get(e.user) || 0) + 1);
  const creator = e.creator || creators.get(e.mint);
  if (creator && e.user === creator) return; // a coin's creator trading their own coin
  const fees = e.net ? 0 : Number(e.fee || 0n) + Number(e.creator_fee || 0n); // PumpSwap's amounts are the user's own, fees in
  const sol = Number(e.sol_amount);
  const tokens = Number(e.token_amount);
  if (!(tokens > 0)) return;
  const k = `${e.user}:${e.mint}`;
  let pos = positions.get(k);
  if (e.is_buy) {
    const cost = sol + fees;
    if (!pos) {
      if (cost < minFirstBuy) return;
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

/**
 * The PumpSwap pools to follow on the stream: those of graduated coins with a position still open, the most recently
 * graduated first, at most RULES.max_amm_pools. A coin left out has its open positions dropped (they can't close where
 * RektBull sees them), and is counted for the health view.
 */
function pools() {
  const open = new Set();
  for (const k of positions.keys()) open.add(k.slice(k.indexOf(':') + 1));
  const live = [...amm.entries()].filter(([, g]) => open.has(g.mint)).reverse(); // the most recent first
  const kept = live.slice(0, RULES.max_amm_pools);
  const dropped = new Set(live.slice(RULES.max_amm_pools).map(([, g]) => g.mint));
  ammOverflow = dropped.size;
  if (dropped.size) for (const k of positions.keys()) if (dropped.has(k.slice(k.indexOf(':') + 1))) positions.delete(k);
  return kept.map(([pool]) => pool).sort();
}
const poolSummary = () => ({ watched: Math.min(RULES.max_amm_pools, amm.size), known: amm.size, overflow: ammOverflow });

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
     SELECT $13, w, d::date, r, c, p, n, wi, lo, sn, be, t, t > $12
       FROM unnest($1::text[], $2::text[], $3::bigint[], $4::bigint[], $5::bigint[], $6::int[], $7::int[], $8::int[], $9::int[], $10::bigint[], $11::int[])
         AS x(w, d, r, c, p, n, wi, lo, sn, be, t)
     ON CONFLICT (chain, wallet, day) DO UPDATE SET
       realised = wallet_pnl_daily.realised + EXCLUDED.realised, cost = wallet_pnl_daily.cost + EXCLUDED.cost,
       proceeds = wallet_pnl_daily.proceeds + EXCLUDED.proceeds, coins = wallet_pnl_daily.coins + EXCLUDED.coins,
       wins = wallet_pnl_daily.wins + EXCLUDED.wins, losses = wallet_pnl_daily.losses + EXCLUDED.losses,
       snipes = wallet_pnl_daily.snipes + EXCLUDED.snipes, best = GREATEST(wallet_pnl_daily.best, EXCLUDED.best),
       trades = GREATEST(wallet_pnl_daily.trades, EXCLUDED.trades), bot = wallet_pnl_daily.bot OR EXCLUDED.bot, updated_at = now()`,
    [col(r => r.wallet), col(r => r.day), col(r => L(r.realised)), col(r => L(r.cost)), col(r => L(r.proceeds)), col(r => r.coins), col(r => r.wins), col(r => r.losses), col(r => r.snipes), col(r => L(r.best)),
      col(r => (r.day === tradesDay ? trades.get(r.wallet) || 0 : 0)), RULES.bot_trades_per_day, chain],
  );
  return rows.length;
}

return { onEvent, flush, prune, reset, pools, poolSummary, _state: () => ({ positions, days, trades, creates, creators, amm }) };
}

const rankers = { solana: createRanker('solana') };
/** A chain's ranker ('solana' or 'bsc'), made the first time it's asked for. */
const forChain = chain => {
  if (!CHAINS[chain]) throw new Error(`no wallet rankings for ${chain}`);
  return rankers[chain] || (rankers[chain] = createRanker(chain));
};
const solanaRanker = rankers.solana;

/* ── The ranking (web role) ── */

const sol = l => Math.round(Number(l) / LAMPORTS * 1000) / 1000; // SOL or BNB, from lamports or gwei

/**
 * The top wallets by realised profit over a window ('7d' or '30d'), kept five
 * minutes: { window, rules, wallets: [...], source }.
 */
async function top(windowName = '7d', chain = 'solana') {
  const w = WINDOWS[windowName] ? windowName : '7d';
  if (!CHAINS[chain]) chain = 'solana';
  const C = CHAINS[chain];
  return cached(`wallets:top:${chain}:${w}`, 300, async () => {
    const { rows } = await db.query(
      `SELECT wallet, sum(realised)::bigint AS realised, sum(cost)::bigint AS cost, sum(coins)::int AS coins, sum(wins)::int AS wins, sum(losses)::int AS losses,
              sum(snipes)::int AS snipes, max(best)::bigint AS best, max(day) AS last_day
         FROM wallet_pnl_daily
        WHERE chain = $4 AND day > current_date - $1::int
        GROUP BY wallet
       HAVING sum(coins) >= $2 AND NOT bool_or(bot) AND sum(snipes) <= sum(coins) AND sum(realised) > 0
        ORDER BY sum(realised) DESC LIMIT $3`,
      [WINDOWS[w], RULES.min_coins, TOP, chain]);
    const solUsd = await require('../providers/prices').usdPrice(C.priceId).catch(() => null);
    const { rows: [since] } = await db.query(`SELECT min(day) AS first FROM wallet_pnl_daily WHERE chain = $1`, [chain]);
    return {
      chain, unit: C.unit, venue: C.venue, window: w, days: WINDOWS[w], counted_since: since?.first || null, sol_usd: chain === 'solana' ? solUsd : undefined, unit_usd: solUsd,
      // without its stream nothing is counted
      stream: chain === 'solana' ? require('../providers/yellowstone').configured() : require('../trade/memeStream').rankingsOn(),
      rules: describe(chain),
      source: C.source,
      wallets: rows.map((r, i) => ({
        rank: i + 1, wallet: r.wallet,
        realised_native: sol(r.realised), ...(chain === 'solana' ? { realised_sol: sol(r.realised) } : {}), realised_usd: solUsd ? Math.round(Number(r.realised) / LAMPORTS * solUsd) : null,
        return_pct: Number(r.cost) > 0 ? Math.round(Number(r.realised) / Number(r.cost) * 1000) / 10 : null,
        coins: r.coins, wins: r.wins, losses: r.losses, win_rate_pct: r.coins ? Math.round(r.wins / r.coins * 100) : null,
        best_coin_native: sol(r.best), ...(chain === 'solana' ? { best_coin_sol: sol(r.best) } : {}), best_share_pct: Number(r.realised) > 0 ? Math.min(100, Math.round(Number(r.best) / Number(r.realised) * 100)) : null,
        snipes: r.snipes, last_active: r.last_day,
        explorer: `${C.explorer}${r.wallet}`, ...(chain === 'solana' ? { solscan: `${C.explorer}${r.wallet}` } : {}),
      })),
    };
  });
}

/** The rules in plain words, shown with the ranking. */
function describe(chain = 'solana') {
  const C = CHAINS[chain] || CHAINS.solana;
  return [
    chain === 'bsc'
      ? 'Realised profit only: BNB a wallet got back from selling a coin, less what that part cost, after four.meme\'s fee. Coins still held don\'t count.'
      : 'Realised profit only: SOL a wallet got back from selling a coin, less what that part cost, after pump.fun\'s and the creator\'s fees. Coins still held don\'t count.',
    chain === 'bsc'
      ? 'Only trades RektBull saw: positions bought on four.meme\'s bonding curves (coins priced in BNB), and their sales there. A coin bought before RektBull watched, or sold after it moved to PancakeSwap, isn\'t counted; on a busy day the stream\'s daily budget can run out, and trades after it aren\'t counted either.'
      : 'Only trades RektBull saw: positions bought on pump.fun\'s bonding curves, and their sales there or, once the coin moves, on PumpSwap. A coin bought before RektBull watched, or bought first on PumpSwap, isn\'t counted.',
    `A coin counts once ${Math.round(RULES.closed_share * 100)}% of what was bought is sold; a position still open after ${RULES.open_days} days is dropped.`,
    `Left out: a coin's creator trading it; positions that started under ${C.min_first_buy / LAMPORTS} ${C.unit}; buys within ${RULES.snipe_seconds} seconds of a coin's creation (snipes, shown apart).`,
    `Ranked: at least ${RULES.min_coins} coins closed in the window, and a profit. Left out: wallets with over ${RULES.bot_trades_per_day} trades in a day (bots), or more snipes than counted coins.`,
    'Past profit says nothing sure about the next trade: copying a wallet buys after it, at a worse price.',
  ];
}

module.exports = {
  RULES, CHAINS, FLUSH_MS, WINDOWS, top, describe, forChain,
  // Solana's ranker, as before
  onEvent: (...a) => solanaRanker.onEvent(...a), flush: (...a) => solanaRanker.flush(...a), prune: (...a) => solanaRanker.prune(...a),
  reset: () => solanaRanker.reset(), pools: () => solanaRanker.pools(), poolSummary: () => solanaRanker.poolSummary(), _state: () => solanaRanker._state(),
};

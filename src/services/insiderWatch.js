/**
 * Meme Watch on Solana, streamed. Meme Watch (myAgents.js) finds each Solana
 * coin's launch-bundle groups once (launchSafety.js) and re-reads their
 * balances every 6 hours. With the Yellowstone stream live, the same wallets
 * are watched as they trade: within seconds of a group selling, every user who
 * holds the coin and has Meme Watch on is told.
 *
 * - The wallets ride on the one pump.fun stream (pumpStream.js) as extra
 *   filters, 200 wallets each, at most 19 (Chainstack allows 20 per
 *   subscription and pump.fun's program takes one): up to 3,800 wallets.
 *   Beyond that, the rest are left to the 6-hour check, and the health view
 *   says how many. The list is rebuilt every minute and sent to the live
 *   connection only when it changed.
 * - A sale, here, is a transaction after which a group's wallets together
 *   hold less of the coin: a sale or a transfer out of the group. Moves
 *   between the group's own wallets cancel out. Each is recorded once
 *   (solana_insider_sells), from the transaction's own token balances.
 * - Alerts, to each account watching the coin:
 *     the group's first sale seen     high, once per group;
 *     each 20% of what it bought gone critical, the same alert (and key) as
 *                                     the 6-hour check, so nobody is told twice.
 *   "What it bought" is its share of the supply at launch (the bundle check)
 *   times the supply now (Solana RPC, kept a day). What's gone counts the
 *   sales the stream saw, from when it started watching the group.
 * Never sells: each alert links a sell on the Trade desk for the user's wallet
 * to sign.
 */
const db = require('../config/db');
const cache = require('../lib/cache');
const logger = require('../config/logger');
const yellowstone = require('../providers/yellowstone');

const PREFIX = 'watch-';
const STEP_PCT = 20; // the 6-hour check's step: an alert at each 20% of what the group bought

/** The groups Meme Watch watches on Solana: from each enabled Meme Watch's snapshot, merged across accounts. */
async function watchlist() {
  if (require('../admin/agentStates').isOff('meme_watch')) return [];
  const { rows } = await db.query(`SELECT account_id, snapshot FROM agent_settings WHERE agent = 'meme_watch' AND enabled`);
  const groups = new Map();
  for (const r of rows) {
    for (const [key, p] of Object.entries(r.snapshot?.positions || {})) {
      if (!key.startsWith('solana:') || !Array.isArray(p.groups)) continue;
      const mint = key.slice('solana:'.length);
      for (const g of p.groups) {
        if (!g.funder || !Array.isArray(g.wallets)) continue;
        const k = `${mint}|${g.funder}`;
        const cur = groups.get(k) || { mint, funder: g.funder, wallets: new Set(), bought_pct: g.bought_pct, accounts: new Set(), symbol: p.symbol || null };
        for (const w of g.wallets) if (w?.address) cur.wallets.add(w.address);
        cur.accounts.add(r.account_id);
        groups.set(k, cur);
      }
    }
  }
  return [...groups.values()];
}

/** The stream filters for these groups' wallets: 200 a filter, at most `room` filters; and how many wallets didn't fit. */
function filtersFor(groups, room = yellowstone.MAX_FILTERS - 1) {
  const wallets = [...new Set(groups.flatMap(g => [...g.wallets]))].sort();
  const filters = {};
  const per = yellowstone.MAX_ACCOUNTS;
  for (let i = 0; i < wallets.length && i / per < room; i += per) filters[`${PREFIX}${i / per}`] = { accountInclude: wallets.slice(i, i + per) };
  return { filters, wallets: wallets.length, watched: Math.min(wallets.length, room * per), overflow: Math.max(0, wallets.length - room * per) };
}

/** An index for one transaction's balances: wallet -> the groups it's in. */
function indexOf(groups) {
  const byWallet = new Map();
  for (const g of groups) for (const w of g.wallets) byWallet.set(w, [...(byWallet.get(w) || []), g]);
  return byWallet;
}

/**
 * What left each watched group in one transaction (yellowstone.readTransaction):
 * [{ group, sold }] for each group whose wallets, together, hold less of its
 * coin afterwards. Moves between the group's own wallets cancel out.
 */
function salesIn(tx, byWallet) {
  if (tx.failed) return [];
  const net = new Map();
  for (const b of tx.balances || []) {
    for (const g of byWallet.get(b.owner) || []) {
      if (g.mint !== b.mint) continue;
      const k = `${g.mint}|${g.funder}`;
      net.set(k, { group: g, change: (net.get(k)?.change || 0n) + (b.post - b.pre) });
    }
  }
  return [...net.values()].filter(x => x.change < 0n).map(x => ({ group: x.group, sold: -x.change }));
}

const supplyOf = mint => cache.cached(`solana:supply:${mint}`, 86400, async () => BigInt((await require('../providers/rpc').solanaRpc('getTokenSupply', [mint]))?.value?.amount || '0').toString());
const pct = (part, whole) => (whole > 0n ? Number(part * 100000n / whole) / 1000 : null);

/**
 * Records each sale once and raises the alerts for it. Returns how many alerts
 * were raised. `now` and `raise` can be given for tests.
 */
async function record(tx, sales, { raise = require('./myAgents').raise } = {}) {
  let raised = 0;
  for (const { group: g, sold } of sales) {
    const { rowCount } = await db.query(
      `INSERT INTO solana_insider_sells (signature, mint, funder, sold_raw, slot) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [tx.signature, g.mint, g.funder, sold.toString(), tx.slot ? Number(tx.slot) : null],
    );
    if (!rowCount) continue; // seen already (a reconnect can resend a transaction)
    const { rows: [{ total }] } = await db.query('SELECT COALESCE(sum(sold_raw), 0)::text AS total FROM solana_insider_sells WHERE mint = $1 AND funder = $2', [g.mint, g.funder]);
    let supply = 0n;
    try { supply = BigInt(await supplyOf(g.mint)); } catch (err) { logger.warn('insider watch: supply not read', { mint: g.mint, error: err.message }); }
    const soldPctSupply = pct(sold, supply);
    const bought = g.bought_pct && supply ? supply * BigInt(Math.round(g.bought_pct * 1000)) / 100000n : 0n;
    const gonePct = bought > 0n ? Math.min(100, Math.round(Number(BigInt(total) * 1000n / bought) / 10)) : null;
    const name = g.symbol || `${g.mint.slice(0, 6)}…${g.mint.slice(-4)}`;
    const key = `solana:${g.mint}`;
    const source = 'The Yellowstone stream: this transaction\'s token balances, before and after';
    const facts = [
      { text: `Wallets funded from ${g.funder.slice(0, 6)}…${g.funder.slice(-4)} (${g.wallets.size} of them, ${g.bought_pct ?? '?'}% of the supply bought at launch) together hold ${soldPctSupply === null ? 'less' : `${soldPctSupply}% of the supply less`} after transaction ${tx.signature.slice(0, 8)}…: a sale or a transfer out of the group.`, source },
      ...(gonePct === null ? [] : [{ text: `Since RektBull started watching them, ${gonePct}% of what they bought has left the group.`, source: `${source}; the supply from Solana RPC` }]),
    ];
    const detail = { reasons: facts, token: { chain: 'solana', token: g.mint }, sell: require('./myAgents').sellLink('solana', g.mint), signature: tx.signature };
    const alerts = [{ kind: 'meme_watch', severity: 'high', dedupe: `meme:${key}:insiders:${g.funder}:first`, title: `${name} on solana: a launch-bundle wallet just sold`, detail }];
    if (gonePct !== null && gonePct >= STEP_PCT) {
      alerts.push({ kind: 'meme_watch', severity: 'critical', dedupe: `meme:${key}:insiders:${g.funder}:${Math.floor(gonePct / STEP_PCT)}`, title: `${name} on solana: launch-bundle wallets are selling (${gonePct}% of what they bought is gone)`, detail });
    }
    const { rows: accounts } = await db.query('SELECT id, wallet, solana_wallet FROM accounts WHERE id = ANY($1::bigint[])', [[...g.accounts]]);
    for (const a of accounts) raised += await raise(a.id, alerts.map(x => ({ ...x, wallet: a.solana_wallet || a.wallet })));
  }
  return raised;
}

/* ── run alongside the pump.fun stream, by the worker that holds it ── */

let current = { groups: [], byWallet: new Map(), key: '', summary: { wallets: 0, watched: 0, overflow: 0, coins: 0 } };
const busy = { on: false };

/** Rebuilds the list and gives the stream its filters when they changed. pumpFilter: the pump.fun filter to keep. */
async function refresh(streamName, pumpFilter) {
  const groups = await watchlist();
  const f = filtersFor(groups);
  const key = JSON.stringify(f.filters);
  current = { groups, byWallet: indexOf(groups), key: current.key, summary: { wallets: f.wallets, watched: f.watched, overflow: f.overflow, coins: new Set(groups.map(g => g.mint)).size } };
  if (key !== current.key) {
    current.key = key;
    yellowstone.updateFilters(streamName, { ...pumpFilter, ...f.filters });
    if (f.overflow) logger.warn('insider watch: more wallets than the stream takes; the rest are left to the 6-hour check', { overflow: f.overflow });
  }
  return current.summary;
}

/** One transaction from the stream: the sales in it, if any, recorded and alerted (one at a time, in order). */
function onTransaction(tx) {
  const sales = salesIn(tx, current.byWallet);
  if (!sales.length) return;
  const go = () => record(tx, sales).catch(err => logger.warn('insider watch: a sale could not be recorded', { signature: tx.signature, error: err.message }));
  busy.chain = (busy.chain || Promise.resolve()).then(go);
}

const summary = () => current.summary;
const _set = groups => { current = { ...current, groups, byWallet: indexOf(groups) }; };

module.exports = { PREFIX, STEP_PCT, watchlist, filtersFor, salesIn, indexOf, record, refresh, onTransaction, summary, _set };

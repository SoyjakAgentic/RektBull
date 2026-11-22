/**
 * Polymarket fills carrying RektBull's builder code, read from Polymarket's
 * public builder-trades feed (GET clob.polymarket.com/builder/trades,
 * docs.polymarket.com/api-reference/trade/get-builder-trades), for RektBull
 * Points: each confirmed fill of an order RektBull prepared earns its user a
 * rebate of the builder fee on it.
 *
 * A fill is matched to a user by the order hash RektBull stored when it
 * prepared the order (`takerOrderHash`), or else by the fill's maker wallet.
 * The fee is RektBull's builder rate on the fill's USDC size (`sizeUsdc`, six
 * decimals): the taker rate for a TAKER trade, the maker rate otherwise. The
 * feed's own fee fields aren't documented as the builder fee, so they aren't
 * used. A fill credited once is never credited again (rewards/points.js).
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const pm = require('../providers/polymarket');
const points = require('../rewards/points');
const builders = require('./builders');

const LOOKBACK_S = 2 * 86400; // every pass reads the last two days: a fill missed once is caught next time
const MAX_PAGES = 50;
const END = 'LTE='; // the feed's last-page cursor

/** The account a fill belongs to: by the order RektBull prepared, else by the wallet that made it. */
async function accountFor(t) {
  const hash = String(t.takerOrderHash || '').toLowerCase();
  if (hash) {
    const { rows } = await db.query('SELECT account_id FROM polymarket_orders WHERE lower(order_hash) = $1 LIMIT 1', [hash]);
    if (rows[0]) return rows[0].account_id;
  }
  const maker = String(t.maker || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(maker)) return null;
  const { rows } = await db.query('SELECT account_id FROM polymarket_orders WHERE wallet = $1 ORDER BY created_at DESC LIMIT 1', [maker]);
  if (rows[0]) return rows[0].account_id;
  // An automatic entry: the Deposit Wallet a user authorized RektBull's Session Key for.
  const { rows: s } = await db.query('SELECT account_id FROM polymarket_sessions WHERE wallet = $1 ORDER BY created_at DESC LIMIT 1', [maker]);
  return s[0]?.account_id || null;
}

/** RektBull's builder fee on one fill, in dollars, at the rates of the code it carried. */
function feeOf(t, b = builders.main()) {
  const usd = Number(t.sizeUsdc) / 1e6;
  if (!(usd > 0)) return 0;
  const bps = String(t.tradeType).toUpperCase() === 'TAKER' ? b.takerBps : b.makerBps;
  return usd * bps / 10000;
}

/** One pass: read the recent fills and credit the rebates not yet credited. */
async function tick({ now = Date.now() } = {}) {
  if (!env.polymarketBuilderCode || !env.databaseUrl) return { read: 0, credited: 0 };
  const after = String(Math.floor(now / 1000) - LOOKBACK_S);
  let read = 0; let credited = 0;
  for (const b of builders.all()) { // the main code and the AI code each have their own feed
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const out = await pm.builderTrades(b.code, { cursor, after });
      const trades = Array.isArray(out?.data) ? out.data : [];
      for (const t of trades) {
        read++;
        if (String(t.builder || '').toLowerCase() !== b.code) continue;
        if (!/CONFIRMED/i.test(String(t.status || ''))) continue; // only fills settled onchain
        const accountId = await accountFor(t);
        const feeUsd = feeOf(t, b);
        if (!accountId || !(feeUsd > 0)) continue;
        const row = await points.safeCredit({ accountId, source: 'polymarket_fill', ref: String(t.id), feeUsd });
        if (row) credited++;
      }
      cursor = out?.next_cursor;
      if (!cursor || cursor === END || !trades.length) break;
    }
  }
  if (credited) logger.info('Polymarket fills rebated in RektBull Points', { read, credited });
  return { read, credited };
}

module.exports = { tick, feeOf, accountFor, LOOKBACK_S };

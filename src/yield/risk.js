/**
 * The yield risk watcher (carried over from soyjak-agentic's yieldRiskRules
 * and yieldRiskWatcher). Every five minutes, in the worker, it reads every
 * venue and asks what is wrong now:
 *
 *   critical (withdraw now):
 *     - a lending market (Aave, Compound) borrowed at or above 98%:
 *       withdrawals are about to stop;
 *     - what a deposit is worth fell (Aave's normalized income, Spark's
 *       assets per share): it only ever grows, so a fall is a loss;
 *     - more than 20% of a large market's supply (at least $1M) left within
 *       an hour, an exploit signal;
 *     - Aave's oracle price for WETH, USDC or USDT on a chain more than 5%
 *       from DefiLlama's: every lending venue on that chain.
 *   high:
 *     - USDC or USDT below $0.98 on the chain's Aave oracle;
 *     - withdrawals paused by the protocol itself.
 *
 * A condition that couldn't be read is never taken as cleared. While a
 * warning stands, nothing is proposed into that venue (rules.js). Safety Pro
 * accounts whose watched wallets hold a position there get a risk monitor
 * alert (Telegram, email, push), with a link to withdraw. Automatic exits
 * belong to automatic rebalancing, which is off.
 */
const axios = require('axios');
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const { track } = require('../providers/usage');
const { cached } = require('../lib/cache');
const venues = require('./venues');
const rates = require('./rates');

const LIMITS = { exit_utilization_pct: 98, depeg_below: 0.98, outflow_pct: 20, outflow_window_minutes: 60, outflow_min_usd: 1000000, oracle_deviation_pct: 5 };
const LLAMA_COIN = { WETH: 'coingecko:ethereum', USDC: 'coingecko:usd-coin', USDT: 'coingecko:tether' };

async function getState(key) {
  const { rows } = await db.query('SELECT value FROM yield_risk_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}
const setState = (key, value) => db.query(
  `INSERT INTO yield_risk_state (key, value, updated_at) VALUES ($1, $2, now())
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);

/** The warnings standing now: { "protocol:chain:asset": reason }, for the rules. */
async function blocked() {
  if (!env.databaseUrl) return {};
  const w = (await getState('warnings')) || {};
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v.reason]));
}

const marketPrices = () => cached('yield:risk:llama-coins', 5 * 60, async () => {
  const ids = Object.values(LLAMA_COIN).join(',');
  const data = await track('defillama', async () => (await axios.get(`https://coins.llama.fi/prices/current/${ids}`, { timeout: 10000 })).data);
  return Object.fromEntries(Object.entries(LLAMA_COIN).map(([a, id]) => [a, data?.coins?.[id]?.price ?? null]));
});

/** What is wrong now, per venue and asset; and what couldn't be read. */
async function detect({ now = Date.now(), chains = Object.keys(venues.CHAINS) } = {}) {
  const warnings = {}; const notRead = [];
  const warn = (v, asset, severity, reason, source) => {
    const key = `${v.protocol}:${v.chain}:${asset}`;
    if (!warnings[key] || severity === 'critical') warnings[key] = { severity, reason, source, protocol: v.protocol, chain: v.chain, asset, name: v.name };
  };
  let market = null;
  try { market = await marketPrices(); } catch (err) { notRead.push({ check: 'market prices (DefiLlama)', reason: err.message }); }
  const highs = (await getState('index_highs')) || {};
  const samples = (await getState('supply_samples')) || {};

  for (const chain of chains) {
    // Prices: depegs, and Aave's oracle against the market.
    const oracle = {};
    for (const asset of Object.keys(venues.TOKENS[chain])) {
      try { oracle[asset] = await rates.priceUsd(chain, asset); } catch (err) { notRead.push({ check: `Aave oracle ${asset} on ${chain}`, reason: err.message }); }
    }
    const chainVenues = venues.VENUES.filter(v => v.chain === chain);
    for (const [asset, p] of Object.entries(oracle)) {
      const t = venues.tokenOf(chain, asset);
      if (t.stable && p < LIMITS.depeg_below) {
        for (const v of chainVenues.filter(x => x.assets.includes(asset))) warn(v, asset, 'high', `${asset} is at $${p.toFixed(4)} on ${venues.CHAINS[chain].label}, below $${LIMITS.depeg_below}.`, `${venues.CHAINS[chain].label} Aave oracle`);
      }
      const m = market?.[asset];
      if (m && Math.abs(p - m) / m * 100 > LIMITS.oracle_deviation_pct) {
        for (const v of chainVenues.filter(x => x.kind !== 'spark')) for (const a of v.assets) warn(v, a, 'critical', `Aave's price for ${asset} on ${venues.CHAINS[chain].label} ($${p.toFixed(2)}) is more than ${LIMITS.oracle_deviation_pct}% from the market's ($${m.toFixed(2)}): lending markets there can be drained through a bad price.`, 'Aave oracle vs DefiLlama');
      }
    }
    // Each venue.
    for (const v of chainVenues) {
      for (const asset of v.assets) {
        const key = `${v.protocol}:${v.chain}:${asset}`;
        const r = await rates.venueRate(v, asset, { crossCheck: false });
        if (r.apy_pct === null) { notRead.push({ check: `${v.name} ${asset} on ${chain}`, reason: r.error || 'unreadable' }); continue; }
        const src = `${v.name}'s contracts onchain`;
        if (r.utilization_pct !== null && r.utilization_pct >= LIMITS.exit_utilization_pct) warn(v, asset, 'critical', `${v.name} ${asset} on ${venues.CHAINS[chain].label} is ${r.utilization_pct}% borrowed: withdrawals may stop until borrowers repay.`, src);
        if (r.withdraw_open === false) warn(v, asset, 'high', `${v.name} has paused ${asset} withdrawals on ${venues.CHAINS[chain].label}.`, src);
        if (r.index) {
          const idx = BigInt(r.index);
          const high = highs[key] ? BigInt(highs[key]) : 0n;
          if (high && idx < high) warn(v, asset, 'critical', `What a ${asset} deposit in ${v.name} on ${venues.CHAINS[chain].label} is worth fell, which shouldn't happen: a loss in the market.`, src);
          if (idx > high) highs[key] = idx.toString();
        }
        const supplied = r.supplied === null ? null : Number(r.supplied) * (oracle[asset] ?? (venues.tokenOf(chain, asset).stable ? 1 : null) ?? 0);
        if (supplied !== null) {
          const list = (samples[key] || []).filter(s => now - s.at <= 2 * LIMITS.outflow_window_minutes * 60000);
          const old = list.find(s => now - s.at >= LIMITS.outflow_window_minutes * 60000 * 0.8);
          if (old && old.usd >= LIMITS.outflow_min_usd && (old.usd - supplied) / old.usd * 100 > LIMITS.outflow_pct) {
            warn(v, asset, 'critical', `${Math.round((old.usd - supplied) / old.usd * 100)}% of ${v.name}'s ${asset} supply on ${venues.CHAINS[chain].label} left in the last hour: a sign of an exploit or a run.`, src);
          }
          list.push({ at: now, usd: Math.round(supplied) });
          samples[key] = list.slice(-30);
        }
      }
    }
  }
  return { warnings, notRead, highs, samples };
}

/** Alerts Safety Pro accounts whose watched wallets hold a position in a venue with a new warning. */
async function alertHolders(fresh) {
  if (!Object.keys(fresh).length) return 0;
  const positions = require('./positions');
  const passes = require('../payments/passes');
  const { rows } = await db.query('SELECT id, account_id, wallet FROM monitored_wallets');
  const day = new Date().toISOString().slice(0, 10);
  const raised = [];
  for (const w of rows) {
    if (!(await passes.covering(w.account_id, 'risk_monitor'))) continue;
    let pos;
    try { pos = await positions.read(w.wallet); } catch (err) { logger.warn('yield risk: positions unreadable', { wallet: w.wallet, error: err.message }); continue; }
    for (const p of pos.positions) {
      const key = `${p.protocol}:${p.chain}:${p.asset}`;
      const warning = fresh[key];
      if (!warning) continue;
      const { rows: ins } = await db.query(
        `INSERT INTO monitor_alerts (account_id, wallet_id, wallet, kind, severity, title, detail, dedupe_key)
         VALUES ($1, $2, $3, 'yield_risk', $4, $5, $6, $7) ON CONFLICT (account_id, dedupe_key) DO NOTHING RETURNING id`,
        [w.account_id, w.id, w.wallet, warning.severity, `${warning.severity === 'critical' ? 'Withdraw now: ' : ''}${p.name} ${p.asset} on ${venues.CHAINS[p.chain].label}`,
          JSON.stringify({ reasons: [{ text: warning.reason, source: warning.source }], position: { protocol: p.protocol, chain: p.chain, asset: p.asset, amount: p.amount, usd: p.usd } }),
          `${w.wallet}:yield:${key}:${warning.severity}:${day}`],
      );
      if (ins.length) raised.push(ins[0].id);
    }
  }
  if (raised.length) await require('../alerts/dispatch').enqueue(raised);
  return raised.length;
}

/** The worker's job, every five minutes. */
async function tick() {
  const { warnings, notRead, highs, samples } = await detect();
  const before = (await getState('warnings')) || {};
  const fresh = Object.fromEntries(Object.entries(warnings).filter(([k, w]) => !before[k] || (before[k].severity !== w.severity && w.severity === 'critical')));
  // A warning on a venue that couldn't be read this time stays up.
  const stillUnread = Object.fromEntries(Object.entries(before).filter(([k]) => !warnings[k] && notRead.some(n => n.check.includes(before[k].name) && n.check.includes(before[k].asset))));
  await setState('warnings', { ...stillUnread, ...warnings });
  await setState('index_highs', highs);
  await setState('supply_samples', samples);
  if (notRead.length) logger.warn('yield risk: some checks couldn\'t run', { not_read: notRead.slice(0, 10) });
  const alerted = await alertHolders(fresh);
  return { warnings: Object.keys(warnings).length, fresh: Object.keys(fresh).length, alerted, not_read: notRead };
}

/** What's being warned about now, for the page. */
async function current() {
  return { warnings: Object.values((await getState('warnings')) || {}), limits: LIMITS };
}

module.exports = { LIMITS, detect, tick, blocked, current, alertHolders };

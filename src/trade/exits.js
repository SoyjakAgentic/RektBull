/**
 * The exit watcher for positions bought automatically, ported from
 * soyjak-agentic's positionWatcher.js (§637): each position is valued at the
 * router's reference price, and sold in full when it is down by the user's
 * stop-loss or up by their take-profit. These are the user's own numbers,
 * checked the same way every time; no model is involved.
 *
 * The sale is an autonomous trade like any other. Selling what the router
 * bought is exempt from the user's limits onchain, so an exit is never
 * blocked by them. A position has at most one exit in flight; a failed exit
 * is retried after RETRY_MINUTES. Nothing runs for a user who turned auto
 * exits off, or whose permission is no longer active.
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const networks = require('./networks');
const venues = require('./venues');
const autonomous = require('./autonomous');

const RETRY_MINUTES = 15;

/** Why to exit now, or null: the user's stop-loss, then their take-profit. */
function exitReason({ valueUsd, costUsd, stopLossPct, takeProfitPct }) {
  if (!(costUsd > 0)) return null;
  const pnl = (valueUsd - costUsd) / costUsd * 100;
  if (pnl <= -stopLossPct) return `Stop-loss: down ${Math.abs(pnl).toFixed(1)}%, past your ${stopLossPct}% limit.`;
  if (pnl >= takeProfitPct) return `Take-profit: up ${pnl.toFixed(1)}%, past your ${takeProfitPct}% target.`;
  return null;
}

async function tick() {
  if (!env.tradingEnabled) return;
  for (const chainId of networks.chainIds()) {
    const net = networks.network(chainId);
    const { rows } = await db.query(
      `SELECT p.*, a.wallet,
              COALESCE(s.stop_loss_pct, 20) AS stop_loss_pct, COALESCE(s.take_profit_pct, 50) AS take_profit_pct, COALESCE(s.auto_exit, true) AS auto_exit
         FROM positions p JOIN accounts a ON a.id = p.account_id
         LEFT JOIN trade_settings s ON s.account_id = p.account_id
        WHERE p.chain = $1 AND p.amount_raw > 0 AND p.exit_intent_id IS NULL`,
      [net.name],
    );
    for (const p of rows) {
      try {
        if (!p.auto_exit) continue;
        const { rows: recent } = await db.query(
          `SELECT 1 FROM trade_intents WHERE account_id = $1 AND chain_id = $2 AND token = $3 AND source = 'exit' AND status = 'failed'
             AND finished_at > now() - make_interval(mins => $4) LIMIT 1`,
          [p.account_id, chainId, p.token, RETRY_MINUTES],
        );
        if (recent.length) continue;
        const valueUsd = Number(await venues.view(net, 'valueUsd', [p.token, BigInt(p.amount_raw)])) / 1e8;
        const reason = exitReason({ valueUsd, costUsd: Number(p.cost_usd), stopLossPct: Number(p.stop_loss_pct), takeProfitPct: Number(p.take_profit_pct) });
        if (!reason) continue;
        const intent = await autonomous.queue({ id: Number(p.account_id), wallet: p.wallet }, { chain_id: chainId, side: 'sell', token: p.token, base: net.defaultBase, sell_amount: p.amount_raw }, { source: 'exit', reason });
        await db.query('UPDATE positions SET exit_intent_id = $4 WHERE account_id = $1 AND chain = $2 AND token = $3', [p.account_id, net.name, p.token, intent.id]);
        logger.info('exit queued', { account: p.account_id, token: p.token, reason });
      } catch (err) {
        // e.g. no active permission any more: the position is left to the user.
        logger.warn('exit not queued', { account: p.account_id, token: p.token, error: err.message });
      }
    }
  }
}

module.exports = { tick, exitReason };

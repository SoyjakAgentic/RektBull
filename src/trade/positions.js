/**
 * Confirms trades the user's wallet sent, and keeps the positions RektBull's
 * trades built. Runs in the trade service (SERVICE_ROLE=trade or all).
 *
 * A trade is confirmed only when its receipt succeeded and moved the trade's
 * tokens for this wallet: a buy delivered the token to the wallet, a sell
 * took it from the wallet. A hash for someone else's transaction confirms
 * nothing. Smart-contract wallets (Safe, Coinbase Smart Wallet) send from
 * another address, which is why the check is the token transfer, not `from`.
 */
const { ethers } = require('ethers');
const db = require('../config/db');
const logger = require('../config/logger');
const { evmRpc } = require('../providers/rpc');

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const NOT_SEEN_MINUTES = 30;
const addr = topic => ('0x' + String(topic).slice(-40)).toLowerCase();

/** Sum of `token` moved to (dir 'in') or from (dir 'out') `wallet` in a receipt's logs. */
function moved(receipt, token, wallet, dir) {
  let total = 0n;
  for (const log of receipt?.logs || []) {
    if (String(log.address).toLowerCase() !== token || log.topics?.[0]?.toLowerCase() !== TRANSFER || log.topics.length < 3) continue;
    const party = dir === 'in' ? addr(log.topics[2]) : addr(log.topics[1]);
    if (party === wallet) total += BigInt(log.data && log.data !== '0x' ? log.data : 0);
  }
  return total;
}

async function settle(row, receipt) {
  const wallet = row.wallet.toLowerCase();
  if (receipt.status !== '0x1') {
    await db.query(`UPDATE trade_proposals SET status = 'failed', error = 'the transaction reverted onchain', finished_at = now() WHERE id = $1`, [row.id]);
    return;
  }
  const amount = moved(receipt, row.token, wallet, row.side === 'buy' ? 'in' : 'out');
  if (amount === 0n) {
    await db.query(`UPDATE trade_proposals SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [row.id, `that transaction didn't move ${row.token} for this wallet`]);
    return;
  }
  await db.tx(async c => {
    if (row.side === 'buy') {
      await c.query(
        `INSERT INTO positions (account_id, chain, token, amount_raw, cost_usd) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, chain, token) DO UPDATE SET amount_raw = positions.amount_raw + $4, cost_usd = positions.cost_usd + $5, updated_at = now()`,
        [row.account_id, row.chain, row.token, amount.toString(), Number(row.amount_usd)],
      );
    } else {
      // A sale shrinks the position, and its cost, in proportion.
      await c.query(
        `UPDATE positions SET
           cost_usd = CASE WHEN amount_raw <= $4 THEN 0 ELSE cost_usd * (amount_raw - $4) / amount_raw END,
           amount_raw = GREATEST(amount_raw - $4, 0), updated_at = now()
         WHERE account_id = $1 AND chain = $2 AND token = $3`,
        [row.account_id, row.chain, row.token, amount.toString()],
      );
    }
    await c.query(`UPDATE trade_proposals SET status = 'confirmed', finished_at = now() WHERE id = $1`, [row.id]);
  });
  logger.info('trade confirmed', { proposal: row.id, side: row.side, chain: row.chain });
}

async function tick() {
  const { rows } = await db.query(`SELECT * FROM trade_proposals WHERE status = 'submitted' ORDER BY submitted_at LIMIT 50`);
  for (const row of rows) {
    try {
      const receipt = await evmRpc(row.chain, 'eth_getTransactionReceipt', [row.tx_hash]);
      if (receipt) await settle(row, receipt);
      else if (Date.now() - new Date(row.submitted_at).getTime() > NOT_SEEN_MINUTES * 60 * 1000) {
        await db.query(`UPDATE trade_proposals SET status = 'failed', error = 'the transaction was not seen onchain within 30 minutes', finished_at = now() WHERE id = $1`, [row.id]);
      }
    } catch (err) {
      logger.error('trade confirmation failed', { proposal: row.id, error: err.message });
    }
  }
  await db.query(`UPDATE trade_proposals SET status = 'expired', finished_at = now() WHERE status IN ('proposed', 'approved') AND created_at < now() - interval '1 hour'`);
}

async function list(accountId) {
  const { rows } = await db.query('SELECT chain, token, amount_raw, cost_usd, updated_at FROM positions WHERE account_id = $1 AND amount_raw > 0 ORDER BY updated_at DESC', [accountId]);
  return rows.map(r => ({ chain: r.chain, token: r.token, amount_raw: r.amount_raw, cost_usd: Number(r.cost_usd), updated_at: r.updated_at }));
}

module.exports = { tick, settle, moved, list };

/**
 * Watches deposit addresses for USDT/USDC transfers and turns them into
 * credits. Runs in the worker (SERVICE_ROLE=worker or all).
 *
 * Each pass, per chain and token:
 *  1. scan: Transfer logs to any watched deposit address, from the saved
 *     cursor, at most WATCHER_MAX_BLOCK_RANGE blocks at a time (free RPC
 *     plans limit eth_getLogs ranges). Each transfer is saved as 'seen'.
 *  2. confirm: once a 'seen' transfer has the chain's confirmations, its
 *     receipt is read again. If the transfer is still there and succeeded,
 *     it is credited (once: the ledger ref is the chain, tx and log index);
 *     if a reorg removed it, it is marked 'reorged' and never credited.
 *
 * Watched addresses are those of accounts with an invoice in the last
 * WATCH_ADDRESS_DAYS days, which keeps the log filter small.
 */
const { ethers } = require('ethers');
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const { evmRpc } = require('../providers/rpc');
const { STABLECOINS, rawToCents } = require('./stablecoins');
const credits = require('./credits');
const invoices = require('./invoices');

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const ADDRESS_CHUNK = 50;
const FIRST_RUN_LOOKBACK = 200;

const padTopic = address => '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const topicToAddress = topic => ('0x' + String(topic).slice(-40)).toLowerCase();
const hexToNum = h => Number(BigInt(h));

/** A Transfer log as { from, to, raw, txHash, logIndex, blockNumber }, or null if it isn't one. */
function parseTransferLog(log) {
  if (!log || log.topics?.[0]?.toLowerCase() !== TRANSFER || log.topics.length < 3) return null;
  return {
    token: String(log.address).toLowerCase(),
    from: topicToAddress(log.topics[1]),
    to: topicToAddress(log.topics[2]),
    raw: BigInt(log.data && log.data !== '0x' ? log.data : 0).toString(),
    txHash: String(log.transactionHash).toLowerCase(),
    logIndex: hexToNum(log.logIndex),
    blockNumber: hexToNum(log.blockNumber),
  };
}

async function watchedAddresses() {
  const { rows } = await db.query(
    `SELECT DISTINCT i.deposit_address AS address, i.account_id FROM invoices i
     WHERE i.created_at > now() - make_interval(days => $1)`,
    [env.watchAddressDays],
  );
  return new Map(rows.map(r => [r.address, Number(r.account_id)]));
}

async function scan(chain, symbol, coin, addresses, latest) {
  const { rows } = await db.query('SELECT last_block FROM watcher_cursors WHERE chain = $1 AND token = $2', [chain, symbol]);
  const from = rows.length ? Number(rows[0].last_block) + 1 : Math.max(latest - FIRST_RUN_LOOKBACK, 0);
  if (from > latest) return;
  const to = Math.min(latest, from + env.watcherMaxBlockRange - 1);
  const list = [...addresses.keys()];
  for (let i = 0; i < list.length; i += ADDRESS_CHUNK) {
    const topics = [TRANSFER, null, list.slice(i, i + ADDRESS_CHUNK).map(padTopic)];
    const logs = await evmRpc(chain, 'eth_getLogs', [{ address: coin.address, topics, fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(to) }]);
    for (const log of logs || []) {
      const t = parseTransferLog(log);
      if (!t || !addresses.has(t.to)) continue;
      const cents = rawToCents(t.raw, coin.decimals);
      if (cents <= 0) continue;
      await db.query(
        `INSERT INTO deposits (chain, token, tx_hash, log_index, block_number, from_address, to_address, account_id, amount_raw, amount_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (chain, tx_hash, log_index) DO NOTHING`,
        [chain, symbol, t.txHash, t.logIndex, t.blockNumber, t.from, t.to, addresses.get(t.to), t.raw, cents],
      );
    }
  }
  await db.query(
    `INSERT INTO watcher_cursors (chain, token, last_block) VALUES ($1, $2, $3)
     ON CONFLICT (chain, token) DO UPDATE SET last_block = EXCLUDED.last_block`,
    [chain, symbol, to],
  );
}

/** True when the receipt still has this exact transfer and the transaction succeeded. */
function receiptHasTransfer(receipt, d, coin) {
  if (!receipt || receipt.status !== '0x1') return false;
  return (receipt.logs || []).some(log => {
    const t = parseTransferLog(log);
    return t && t.token === coin.address && t.logIndex === Number(d.log_index) && t.to === d.to_address && t.raw === String(d.amount_raw);
  });
}

async function confirm(chain, symbol, coin, latest, confirmations) {
  const { rows } = await db.query(
    `SELECT * FROM deposits WHERE chain = $1 AND token = $2 AND status = 'seen' AND block_number <= $3 ORDER BY id LIMIT 100`,
    [chain, symbol, latest - confirmations],
  );
  for (const d of rows) {
    const receipt = await evmRpc(chain, 'eth_getTransactionReceipt', [d.tx_hash]);
    if (!receiptHasTransfer(receipt, d, coin)) {
      await db.query(`UPDATE deposits SET status = 'reorged' WHERE id = $1`, [d.id]);
      logger.warn('deposit no longer on chain; not credited', { chain, tx: d.tx_hash });
      continue;
    }
    const added = await credits.add(Number(d.account_id), d.amount_cents, 'deposit', `deposit:${chain}:${d.tx_hash}:${d.log_index}`);
    await db.query(`UPDATE deposits SET status = 'credited', credited_at = now() WHERE id = $1`, [d.id]);
    if (added) {
      logger.info('deposit credited', { chain, token: symbol, cents: d.amount_cents, account: d.account_id });
      await invoices.applyDeposit({ account_id: Number(d.account_id), chain, token: symbol, amount_cents: d.amount_cents });
    }
  }
}

async function tick() {
  await invoices.expireOld();
  const addresses = await watchedAddresses();
  for (const chain of env.paymentChains) {
    const cfg = STABLECOINS[chain];
    if (!cfg) continue;
    try {
      const latest = hexToNum(await evmRpc(chain, 'eth_blockNumber', []));
      for (const [symbol, coin] of Object.entries(cfg.tokens)) {
        if (addresses.size) await scan(chain, symbol, coin, addresses, latest);
        await confirm(chain, symbol, coin, latest, cfg.confirmations);
      }
    } catch (err) {
      logger.error('watcher pass failed', { chain, error: err.message });
    }
  }
}

let running = false;
function start() {
  const loop = async () => {
    if (running) return;
    running = true;
    try { await tick(); } catch (err) { logger.error('watcher tick failed', { error: err.message }); } finally { running = false; }
  };
  loop();
  return setInterval(loop, env.watcherIntervalMs);
}

module.exports = { start, tick, parseTransferLog, receiptHasTransfer, padTopic, topicToAddress, TRANSFER };

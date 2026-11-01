/**
 * Approve-each trades: RektBull proposes, the user's own wallet signs.
 *
 *   propose  -> every check runs on an indicative basis and the plan is shown;
 *   approve  -> every check runs again on a fresh firm quote (as in Soyjak:
 *               prices move), and the wallet calls are built;
 *   submit   -> the user's wallet sent them; the trade service confirms the
 *               transaction onchain and records the position.
 *
 * Trading is only ever from the signed-in wallet: a session for one wallet
 * can't propose trades for another.
 */
const crypto = require('crypto');
const db = require('../config/db');
const rules = require('./rules');
const { walletCalls } = require('./calls');

const APPROVE_WINDOW_MINUTES = 30; // a proposal not approved by then expires
const json = v => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

function present(row) {
  return {
    id: row.id, status: row.status, chain: row.chain, side: row.side, token: row.token, base: row.base,
    amount_usd: row.amount_usd === null ? null : Number(row.amount_usd),
    sell_fraction: row.sell_fraction === null ? null : Number(row.sell_fraction),
    plan: row.plan, calls: row.status === 'approved' ? row.calls : undefined,
    tx_hash: row.tx_hash, error: row.error,
    created_at: row.created_at, approved_at: row.approved_at, submitted_at: row.submitted_at, finished_at: row.finished_at,
  };
}

const planView = p => ({ summary: p.summary, checks: p.checks, value_usd: p.valueUsd });

async function propose(account, input) {
  const p = await rules.prepare({
    accountId: account.id, wallet: account.wallet, chain: input.chain, side: input.side, token: input.token,
    base: input.base, amountUsd: input.amount_usd, sellFraction: input.sell_fraction, acknowledgeRisks: !!input.acknowledge_risks,
  });
  const id = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO trade_proposals (id, account_id, wallet, chain, side, token, base, amount_usd, sell_fraction, plan)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [id, account.id, account.wallet, p.chain, p.side, p.token, p.base, p.side === 'buy' ? p.valueUsd : null, p.sellFraction || null,
      json({ ...planView(p), acknowledge_risks: !!input.acknowledge_risks })],
  );
  return present(rows[0]);
}

async function load(account, id, client = db) {
  const { rows } = await client.query('SELECT * FROM trade_proposals WHERE id = $1 AND account_id = $2', [id, account.id]);
  if (!rows.length) throw Object.assign(new Error('trade proposal not found'), { status: 404 });
  return rows[0];
}

async function approve(account, id) {
  const row = await load(account, id);
  if (row.status !== 'proposed') throw Object.assign(new Error(`this proposal is ${row.status}`), { status: 409 });
  if (Date.now() - new Date(row.created_at).getTime() > APPROVE_WINDOW_MINUTES * 60 * 1000) {
    await db.query(`UPDATE trade_proposals SET status = 'expired', finished_at = now() WHERE id = $1`, [id]);
    throw Object.assign(new Error('this proposal has expired; propose the trade again'), { status: 409 });
  }
  let p;
  try {
    p = await rules.prepare({
      accountId: account.id, wallet: account.wallet, chain: row.chain, side: row.side, token: row.token, base: row.base,
      amountUsd: row.amount_usd, sellFraction: row.sell_fraction, acknowledgeRisks: !!row.plan?.acknowledge_risks,
    });
  } catch (err) {
    if (err.isTradeBlocked) await db.query(`UPDATE trade_proposals SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [id, `on approval: ${err.message}`]);
    throw err;
  }
  const calls = walletCalls(p);
  const { rows } = await db.query(
    `UPDATE trade_proposals SET status = 'approved', approved_at = now(), plan = $2, calls = $3 WHERE id = $1 AND status = 'proposed' RETURNING *`,
    [id, json({ ...planView(p), acknowledge_risks: !!row.plan?.acknowledge_risks, sell_amount: p.quote.sellAmount, expected_buy: p.quote.buyAmount }), json(calls)],
  );
  if (!rows.length) throw Object.assign(new Error('this proposal changed while it was being approved'), { status: 409 });
  return present(rows[0]);
}

async function submitted(account, id, txHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) throw Object.assign(new Error('tx_hash must be a transaction hash'), { status: 400 });
  const { rows } = await db.query(
    `UPDATE trade_proposals SET status = 'submitted', tx_hash = $3, submitted_at = now()
     WHERE id = $1 AND account_id = $2 AND status = 'approved' RETURNING *`,
    [id, account.id, txHash.toLowerCase()],
  );
  if (!rows.length) throw Object.assign(new Error('only an approved proposal can be marked as sent'), { status: 409 });
  return present(rows[0]);
}

async function cancel(account, id) {
  const { rows } = await db.query(
    `UPDATE trade_proposals SET status = 'cancelled', finished_at = now() WHERE id = $1 AND account_id = $2 AND status IN ('proposed', 'approved') RETURNING *`,
    [id, account.id],
  );
  if (!rows.length) throw Object.assign(new Error('only a proposal that hasn\'t been sent can be cancelled'), { status: 409 });
  return present(rows[0]);
}

async function list(account) {
  const { rows } = await db.query('SELECT * FROM trade_proposals WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50', [account.id]);
  return rows.map(present);
}

const get = async (account, id) => present(await load(account, id));

module.exports = { propose, approve, submitted, cancel, list, get };

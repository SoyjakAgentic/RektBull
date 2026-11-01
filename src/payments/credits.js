/**
 * Credits: an append-only ledger in cents. Every entry has a ref, so the
 * same deposit, run or refund can never be written twice.
 */
const db = require('../config/db');

class InsufficientCredits extends Error {
  constructor(balance, needed) {
    super('Not enough credits');
    this.balance = balance;
    this.needed = needed;
  }
}

async function balance(accountId, client = db) {
  const { rows } = await client.query('SELECT COALESCE(SUM(delta_cents), 0)::int AS cents FROM credit_ledger WHERE account_id = $1', [accountId]);
  return rows[0].cents;
}

/** Adds an entry; returns false when ref was already written. */
async function add(accountId, deltaCents, reason, ref, client = db) {
  const { rowCount } = await client.query(
    'INSERT INTO credit_ledger (account_id, delta_cents, reason, ref) VALUES ($1, $2, $3, $4) ON CONFLICT (ref) DO NOTHING',
    [accountId, deltaCents, reason, ref],
  );
  return rowCount === 1;
}

/**
 * Takes cents from an account, or throws InsufficientCredits. The account
 * row is locked so two runs at once can't both spend the same balance.
 */
async function spend(accountId, cents, reason, ref) {
  return db.tx(async c => {
    await c.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    const have = await balance(accountId, c);
    if (have < cents) throw new InsufficientCredits(have, cents);
    await add(accountId, -cents, reason, ref, c);
    return have - cents;
  });
}

const refund = (accountId, cents, ref) => add(accountId, cents, 'refund', `refund:${ref}`);

async function history(accountId, limit = 50) {
  const { rows } = await db.query(
    'SELECT delta_cents, reason, ref, created_at FROM credit_ledger WHERE account_id = $1 ORDER BY id DESC LIMIT $2',
    [accountId, limit],
  );
  return rows;
}

module.exports = { balance, add, spend, refund, history, InsufficientCredits };

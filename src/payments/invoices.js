/**
 * Invoices for topping up credits with USDT or USDC.
 *
 * An invoice tells the user what to send and where, and starts the watcher
 * looking at their deposit address. The money itself is credited per
 * deposit, not per invoice: a late, short or extra payment still lands as
 * credits. When deposits cover an invoice it is marked paid, and if it was
 * raised to buy something (a pass), that is bought from the credits then.
 */
const crypto = require('crypto');
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const { stablecoin, centsToRaw } = require('./stablecoins');
const { product } = require('./catalog');
const depositAddress = require('./depositAddress');
const passes = require('./passes');

async function create(accountId, { chain, token, amount_cents, product: productId }) {
  if (!env.paymentChains.includes(chain)) throw Object.assign(new Error(`payments on ${chain} are not enabled`), { status: 400 });
  const coin = stablecoin(chain, token);
  let cents = Number(amount_cents) || 0;
  if (productId) {
    const p = product(productId);
    if (p.kind !== 'pass') throw Object.assign(new Error('only passes can be bought with an invoice; runs are paid from credits or x402'), { status: 400 });
    cents = Math.max(cents, p.price_cents);
  }
  if (!Number.isInteger(cents) || cents < env.minTopUpCents) {
    throw Object.assign(new Error(`the smallest top-up is ${env.minTopUpCents} cents`), { status: 400 });
  }
  const address = await depositAddress.forAccount(accountId);
  const id = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO invoices (id, account_id, chain, token, amount_cents, deposit_address, product, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8)) RETURNING *`,
    [id, accountId, chain, coin.symbol, cents, address, productId || null, env.invoiceExpiryMinutes],
  );
  return present(rows[0]);
}

function present(inv) {
  const coin = stablecoin(inv.chain, inv.token);
  return {
    id: inv.id, status: inv.status, chain: inv.chain, token: inv.token,
    amount_cents: inv.amount_cents, paid_cents: inv.paid_cents,
    send: { to: inv.deposit_address, token_contract: coin.address, amount: (inv.amount_cents / 100).toFixed(2), amount_raw: centsToRaw(inv.amount_cents, coin.decimals).toString() },
    product: inv.product, created_at: inv.created_at, expires_at: inv.expires_at,
    note: 'Send only this token on this chain. Payments are credited after the chain confirms them, even after the invoice expires.',
  };
}

async function get(accountId, id) {
  const { rows } = await db.query('SELECT * FROM invoices WHERE id = $1 AND account_id = $2', [id, accountId]);
  if (!rows.length) throw Object.assign(new Error('invoice not found'), { status: 404 });
  return present(rows[0]);
}

async function list(accountId) {
  const { rows } = await db.query('SELECT * FROM invoices WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50', [accountId]);
  return rows.map(present);
}

/**
 * After a deposit is credited: counts it toward the account's oldest open
 * invoice for that chain and token, and buys the invoice's product once paid.
 */
async function applyDeposit(deposit) {
  const { rows } = await db.query(
    `UPDATE invoices SET paid_cents = paid_cents + $4,
       status = CASE WHEN paid_cents + $4 >= amount_cents THEN 'paid' ELSE status END
     WHERE id = (SELECT id FROM invoices WHERE account_id = $1 AND chain = $2 AND token = $3
                   AND (status = 'pending' OR (status = 'expired' AND created_at > now() - interval '7 days'))
                 ORDER BY created_at LIMIT 1)
     RETURNING *`,
    [deposit.account_id, deposit.chain, deposit.token, deposit.amount_cents],
  );
  const inv = rows[0];
  if (inv?.status === 'paid' && inv.product) {
    try {
      await passes.buy(inv.account_id, inv.product, `invoice:${inv.id}`);
    } catch (err) {
      // The credits are safe either way; the user can buy the pass by hand.
      logger.error('invoice paid but its pass was not bought', { invoice: inv.id, error: err.message });
    }
  }
  return inv || null;
}

async function expireOld() {
  await db.query(`UPDATE invoices SET status = 'expired' WHERE status = 'pending' AND expires_at <= now()`);
}

module.exports = { create, get, list, applyDeposit, expireOld, present };

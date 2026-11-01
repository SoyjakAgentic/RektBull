/**
 * Prepaid passes. Crypto can't safely pull a payment every month, so time
 * is bought up front from credits and simply runs out. Buying again while
 * a pass is active extends it from its current end.
 */
const db = require('../config/db');
const { product } = require('./catalog');
const credits = require('./credits');

async function buy(accountId, productId, ref) {
  const p = product(productId);
  if (p.kind !== 'pass') throw Object.assign(new Error(`${productId} is not a pass`), { status: 400 });
  await credits.spend(accountId, p.price_cents, 'pass', `pass:${ref}`);
  const { rows } = await db.query(
    `INSERT INTO passes (account_id, product, starts_at, ends_at)
     SELECT $1, $2, s, s + make_interval(days => $3)
     FROM (SELECT GREATEST(now(), COALESCE(MAX(ends_at), now())) AS s FROM passes WHERE account_id = $1 AND product = $2) t
     RETURNING product, starts_at, ends_at`,
    [accountId, productId, p.days],
  );
  return rows[0];
}

/** The active pass that covers runProductId, or null. */
async function covering(accountId, runProductId) {
  const { rows } = await db.query(
    `SELECT product, ends_at FROM passes WHERE account_id = $1 AND starts_at <= now() AND ends_at > now() ORDER BY ends_at DESC`,
    [accountId],
  );
  for (const r of rows) {
    const p = product(r.product);
    if ((p.covers || []).includes(runProductId)) return { ...r, fair_use_per_day: p.fair_use_per_day };
  }
  return null;
}

async function active(accountId) {
  const { rows } = await db.query(
    'SELECT product, starts_at, ends_at FROM passes WHERE account_id = $1 AND ends_at > now() ORDER BY ends_at DESC',
    [accountId],
  );
  return rows;
}

module.exports = { buy, covering, active };

/**
 * Free points: a monthly allowance per signed-in wallet (UTC months), spent
 * on runs that have a points cost (catalog.js). Spending is atomic and never
 * goes over the allowance; a failed run gives its points back.
 *
 * A wallet that has never sent a transaction on the chains checked
 * (NEW_WALLET_CHECK_CHAINS, default Ethereum and Base) gets the smaller
 * allowance, so fresh wallets can't be farmed for points. The allowance is
 * fixed when a month's row is first made. If the check can't run, the wallet
 * gets the full allowance: our outage is not the user's fault.
 *
 * The same table also counts what a pass includes per month (e.g. 5 reports).
 */
const db = require('../config/db');
const rpc = require('../providers/rpc');
const { FREE_POINTS } = require('./catalog');

const period = (d = new Date()) => d.toISOString().slice(0, 7);
const nextPeriodStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
const subjectOf = accountId => `account:${accountId}`;

function checkChains() {
  const raw = process.env.NEW_WALLET_CHECK_CHAINS;
  return (raw === undefined ? 'ethereum,base' : raw).split(',').map(s => s.trim()).filter(Boolean);
}

/** True when the wallet has no transactions and no code on any checked chain; null when it couldn't be read. */
async function isNewWallet(wallet) {
  const chains = checkChains();
  if (!chains.length) return false;
  try {
    for (const chain of chains) {
      const [nonce, code] = await Promise.all([
        rpc.evmRpc(chain, 'eth_getTransactionCount', [wallet, 'latest'], { timeout: 5000 }),
        rpc.evmRpc(chain, 'eth_getCode', [wallet, 'latest'], { timeout: 5000 }),
      ]);
      if (typeof nonce !== 'string' || typeof code !== 'string') return null;
      if (Number(nonce) > 0 || code !== '0x') return false;
    }
    return true;
  } catch {
    return null;
  }
}

/** Makes the row for a counter this month if it isn't there; returns it. */
async function ensure(subject, key, allowanceFn, c = db) {
  const p = period();
  const { rows } = await c.query('SELECT allowance, used FROM period_usage WHERE subject = $1 AND key = $2 AND period = $3', [subject, key, p]);
  if (rows.length) return rows[0];
  const allowance = await allowanceFn();
  await c.query('INSERT INTO period_usage (subject, key, period, allowance) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [subject, key, p, allowance]);
  const again = await c.query('SELECT allowance, used FROM period_usage WHERE subject = $1 AND key = $2 AND period = $3', [subject, key, p]);
  return again.rows[0];
}

/** Takes `amount` from a counter this month; false if that would go over its allowance. */
async function take(subject, key, amount, allowanceFn) {
  await ensure(subject, key, allowanceFn);
  const { rows } = await db.query(
    'UPDATE period_usage SET used = used + $4 WHERE subject = $1 AND key = $2 AND period = $3 AND used + $4 <= allowance RETURNING used',
    [subject, key, period(), amount],
  );
  return rows.length === 1;
}

const giveBack = (subject, key, amount) =>
  db.query('UPDATE period_usage SET used = GREATEST(used - $4, 0) WHERE subject = $1 AND key = $2 AND period = $3', [subject, key, period(), amount]);

const pointsAllowance = wallet => async () => ((await isNewWallet(wallet)) === true ? FREE_POINTS.new_wallet : FREE_POINTS.per_month);

/** Spends free points for a run; false when there aren't enough left this month. */
const spend = (account, amount) => take(subjectOf(account.id), 'points', amount, pointsAllowance(account.wallet));
const refund = (account, amount) => giveBack(subjectOf(account.id), 'points', amount);

/** This month's free points for the account: { allowance, used, left, new_wallet, resets_at }. */
async function status(account) {
  const row = await ensure(subjectOf(account.id), 'points', pointsAllowance(account.wallet));
  return {
    period: period(), allowance: row.allowance, used: row.used, left: Math.max(row.allowance - row.used, 0),
    new_wallet: row.allowance < FREE_POINTS.per_month, resets_at: nextPeriodStart(),
  };
}

/** What a pass includes this month for one product (e.g. reports): take one, give one back, or read it. */
const takeIncluded = (accountId, productId, allowance) => take(subjectOf(accountId), `${productId}:pass`, 1, async () => allowance);
const giveBackIncluded = (accountId, productId) => giveBack(subjectOf(accountId), `${productId}:pass`, 1);
async function includedLeft(accountId, productId, allowance) {
  const { rows } = await db.query('SELECT allowance, used FROM period_usage WHERE subject = $1 AND key = $2 AND period = $3', [subjectOf(accountId), `${productId}:pass`, period()]);
  const r = rows[0] || { allowance, used: 0 };
  return { allowance: r.allowance, used: r.used, left: Math.max(r.allowance - r.used, 0) };
}

module.exports = { spend, refund, status, isNewWallet, takeIncluded, giveBackIncluded, includedLeft, period };

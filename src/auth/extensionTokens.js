/**
 * Tokens for the RektBull browser extension. A signed-in user links the
 * extension from rektbull.com/extension; the token it gets:
 *   - lasts 180 days and can be revoked at any time (the list is on that page);
 *   - has scope 'extension', which works only on the routes in ALLOWED: the
 *     pre-sign check and reading the account, the monitor and its alerts.
 *     It can't buy passes, spend credits on anything else, or change settings.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const env = require('../config/env');

const DAYS = 180;
const ALLOWED = [
  ['POST', '/v1/presign/check'],
  ['GET', '/v1/me'],
  ['GET', '/v1/monitor'],
  ['GET', '/v1/monitor/alerts'],
];
const allowed = (method, path) => ALLOWED.some(([m, p]) => m === method && p === path);

// Revocations are checked against the database, at most once a minute per token.
const seen = new Map(); // jti -> { active, at }
async function isActive(jti) {
  const hit = seen.get(jti);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.active;
  const { rows } = await db.query('UPDATE extension_tokens SET last_used_at = now() WHERE jti = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING jti', [jti]);
  const active = rows.length === 1;
  seen.set(jti, { active, at: Date.now() });
  if (seen.size > 5000) seen.delete(seen.keys().next().value);
  return active;
}

async function issue(account, label) {
  if (!env.jwtSecret) throw new Error('JWT_SECRET is not set');
  const jti = crypto.randomUUID();
  await db.query(`INSERT INTO extension_tokens (jti, account_id, label, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))`, [jti, account.id, label ? String(label).slice(0, 60) : null, DAYS]);
  const token = jwt.sign({ sub: String(account.id), wallet: account.wallet, scope: 'extension', jti }, env.jwtSecret, { expiresIn: `${DAYS}d` });
  return { token, jti, expires_in_days: DAYS };
}

async function list(accountId) {
  const { rows } = await db.query('SELECT jti, label, created_at, expires_at, last_used_at FROM extension_tokens WHERE account_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC', [accountId]);
  return rows;
}

async function revoke(accountId, jti) {
  const { rowCount } = await db.query('UPDATE extension_tokens SET revoked_at = now() WHERE jti = $1 AND account_id = $2 AND revoked_at IS NULL', [jti, accountId]);
  seen.delete(jti);
  return rowCount === 1;
}

module.exports = { issue, list, revoke, isActive, allowed, ALLOWED };

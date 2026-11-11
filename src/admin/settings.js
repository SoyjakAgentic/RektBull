/**
 * What the owners changed in the admin panel (admin_settings), kept in memory
 * and read back from the database at most once a minute, so prices and
 * switches can be read synchronously anywhere. Each change is written with a
 * log row (admin_log) in the same transaction.
 *
 * Nothing runs on a timer here: the web service refreshes on a request
 * (app.js), the worker and trade services every minute (server.js). The
 * emergency stops are never read from this copy: read() goes to the database.
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');

const TTL_MS = 60 * 1000;
let cache = new Map();
let loadedAt = 0;
let loading = null;

/** The value an admin set for key, or undefined for the default (may be up to a minute old). */
const get = key => cache.get(key);

async function load() {
  const { rows } = await db.query('SELECT key, value FROM admin_settings');
  cache = new Map(rows.map(r => [r.key, r.value]));
  loadedAt = Date.now();
}

/** Reads the settings again if the copy is more than a minute old. Never throws. */
async function fresh() {
  if (!env.databaseUrl || Date.now() - loadedAt < TTL_MS) return;
  loading ||= load().catch(err => {
    logger.warn('admin settings could not be read; keeping the last copy', { error: err.message });
    loadedAt = Date.now() - TTL_MS + 10 * 1000; // try again in 10 seconds, not on every request
  }).finally(() => { loading = null; });
  await loading;
}

/** One setting straight from the database (for the emergency stops). */
async function read(key) {
  if (!env.databaseUrl) return null;
  const { rows } = await db.query('SELECT value FROM admin_settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

/**
 * Sets key to value (null removes it: back to the default) and logs it, with
 * who, why, and what it was before.
 */
async function set(key, value, { wallet, action, reason }) {
  if (!reason || !String(reason).trim()) throw Object.assign(new Error('Say why (reason).'), { status: 400 });
  const out = await db.tx(async c => {
    const { rows } = await c.query('SELECT value FROM admin_settings WHERE key = $1 FOR UPDATE', [key]);
    const before = rows[0]?.value ?? null;
    if (value === null) await c.query('DELETE FROM admin_settings WHERE key = $1', [key]);
    else {
      await c.query(
        `INSERT INTO admin_settings (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), wallet],
      );
    }
    await c.query('INSERT INTO admin_log (wallet, action, key, before, after, reason) VALUES ($1, $2, $3, $4, $5, $6)',
      [wallet, action, key, before === null ? null : JSON.stringify(before), value === null ? null : JSON.stringify(value), String(reason).trim().slice(0, 500)]);
    return { before, after: value };
  });
  if (value === null) cache.delete(key); else cache.set(key, value);
  return out;
}

/** Writes a log row for an action that isn't a setting (a refund, a test call). */
async function note({ wallet, action, key, before = null, after = null, reason }) {
  await db.query('INSERT INTO admin_log (wallet, action, key, before, after, reason) VALUES ($1, $2, $3, $4, $5, $6)',
    [wallet, action, key, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), String(reason || '').trim().slice(0, 500) || '-']);
}

async function log({ limit = 100, key = null } = {}) {
  const { rows } = await db.query(
    'SELECT id, at, wallet, action, key, before, after, reason FROM admin_log WHERE ($1::text IS NULL OR key = $1 OR key LIKE $1 || \':%\') ORDER BY at DESC, id DESC LIMIT $2',
    [key, Math.min(Math.max(Number(limit) || 100, 1), 500)],
  );
  return rows;
}

/** Tests: forget the copy, or load it now. */
const reset = () => { cache = new Map(); loadedAt = 0; };
const reload = () => load();

module.exports = { get, fresh, read, set, note, log, reset, reload, TTL_MS };

/**
 * Two-level cache: memory in this process, then the database (shared by
 * every instance). Caching is what keeps RektBull inside free API plans, so
 * every provider result worth reusing goes through `cached`.
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');

const MEMORY_MAX = 2000;
const memory = new Map(); // key -> { value, expiresAt }

function memGet(key, now = Date.now()) {
  const hit = memory.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= now) { memory.delete(key); return undefined; }
  return hit.value;
}

function memSet(key, value, ttlSeconds, now = Date.now()) {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value); // oldest first
  memory.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
}

const dbEnabled = () => !!env.databaseUrl;

async function get(key) {
  const m = memGet(key);
  if (m !== undefined) return m;
  if (!dbEnabled()) return undefined;
  try {
    const { rows } = await db.query('SELECT value, expires_at FROM cache WHERE key = $1 AND expires_at > now()', [key]);
    if (!rows.length) return undefined;
    const ttl = Math.max(1, Math.floor((new Date(rows[0].expires_at) - Date.now()) / 1000));
    memSet(key, rows[0].value, ttl);
    return rows[0].value;
  } catch (err) {
    logger.warn('cache read failed', { key, error: err.message });
    return undefined;
  }
}

async function set(key, value, ttlSeconds) {
  memSet(key, value, ttlSeconds);
  if (!dbEnabled()) return;
  try {
    await db.query(
      `INSERT INTO cache (key, value, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(value), ttlSeconds],
    );
  } catch (err) {
    logger.warn('cache write failed', { key, error: err.message });
  }
}

/** The cached value for key, or fn()'s result, stored for ttlSeconds. */
async function cached(key, ttlSeconds, fn) {
  const hit = await get(key);
  if (hit !== undefined) return hit;
  const value = await fn();
  if (value !== undefined) await set(key, value, ttlSeconds);
  return value;
}

async function purgeExpired() {
  if (dbEnabled()) await db.query('DELETE FROM cache WHERE expires_at <= now()');
}

module.exports = { cached, get, set, purgeExpired, _memory: memory, _memGet: memGet, _memSet: memSet };

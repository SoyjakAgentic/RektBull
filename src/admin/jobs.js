/**
 * The background jobs (src/server.js), each run through run(): never two of
 * the same at once, its errors logged, and when it last worked or failed kept
 * in job_runs so the admin panel can show a job that stopped.
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');

/** Every job, how often it runs, and what it does (for the panel). */
const JOBS = {
  deposits: { every_ms: null, role: 'worker', what: 'Credits stablecoin deposits (every WATCHER_INTERVAL_MS)' },
  cache_purge: { every_ms: 60 * 60 * 1000, role: 'worker', what: 'Clears expired cache rows' },
  retention: { every_ms: 60 * 60 * 1000, role: 'worker', what: 'Deletes data past the privacy page\'s periods' },
  nowpayments: { every_ms: 5 * 60 * 1000, role: 'worker', what: 'Re-checks hosted checkouts under way' },
  governance_alerts: { every_ms: 60 * 60 * 1000, role: 'worker', what: 'DAO votes opening or closing (DAO Votes)' },
  newsletter: { every_ms: 5 * 60 * 1000, role: 'worker', what: 'Sends the weekly newsletter' },
  research: { every_ms: 60 * 60 * 1000, role: 'worker', what: 'Drafts the weekly digest' },
  pass_reminders: { every_ms: 60 * 60 * 1000, role: 'worker', what: 'Safety Pro renewal reminders' },
  yield_risk: { every_ms: 5 * 60 * 1000, role: 'worker', what: 'Watches lending venues (Yield Watch)' },
  monitor: { every_ms: 5 * 60 * 1000, role: 'worker', what: 'Re-checks watched wallets (Wallet Guardian)' },
  agents: { every_ms: 5 * 60 * 1000, role: 'worker', what: 'Scheduled AI agents' },
  channel_poster: { every_ms: 30 * 60 * 1000, role: 'worker', what: 'Channel Poster drafts' },
  alerts: { every_ms: 20 * 1000, role: 'worker', what: 'Sends alerts (Telegram, email, push)' },
  trade: { every_ms: null, role: 'trade', what: 'Trades, exits and automatic yield moves' },
};

const busy = new Set();

function save(name, err) {
  if (!env.databaseUrl) return;
  db.query(
    `INSERT INTO job_runs (name, runs, last_ok_at, last_error_at, last_error) VALUES ($1, 1, CASE WHEN $2::text IS NULL THEN now() END, CASE WHEN $2::text IS NOT NULL THEN now() END, $2)
     ON CONFLICT (name) DO UPDATE SET runs = job_runs.runs + 1,
       last_ok_at = CASE WHEN $2::text IS NULL THEN now() ELSE job_runs.last_ok_at END,
       last_error_at = CASE WHEN $2::text IS NOT NULL THEN now() ELSE job_runs.last_error_at END,
       last_error = COALESCE($2, job_runs.last_error)`,
    [name, err ? String(err.message || err).slice(0, 300) : null],
  ).catch(e => logger.warn('could not record a job run', { job: name, error: e.message }));
}

/** Runs one job unless the last run is still going. */
async function run(name, fn) {
  if (busy.has(name)) return;
  busy.add(name);
  try {
    await fn();
    save(name, null);
  } catch (err) {
    logger.error(`${name} failed`, { error: err.message });
    save(name, err);
  } finally {
    busy.delete(name);
  }
}

/** Each job with when it last worked and failed; "late" when it hasn't worked in three of its intervals. */
async function status() {
  const { rows } = await db.query('SELECT * FROM job_runs');
  const by = Object.fromEntries(rows.map(r => [r.name, r]));
  const now = Date.now();
  return Object.entries(JOBS).map(([name, j]) => {
    const r = by[name] || {};
    const every = j.every_ms ?? (j.role === 'trade' ? env.tradeTickMs : env.watcherIntervalMs);
    const lastOk = r.last_ok_at ? new Date(r.last_ok_at).getTime() : null;
    return {
      name, ...j, every_ms: every, runs: Number(r.runs || 0), last_ok_at: r.last_ok_at || null, last_error_at: r.last_error_at || null, last_error: r.last_error || null,
      state: !r.runs ? 'never' : lastOk && now - lastOk <= 3 * every ? (r.last_error_at && new Date(r.last_error_at).getTime() > lastOk ? 'failing' : 'ok') : 'late',
    };
  });
}

module.exports = { JOBS, run, status };

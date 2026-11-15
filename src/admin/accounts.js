/**
 * Account lookup for the admin panel, and the few things an admin may do for
 * an account: add credits, refund a run paid with credits, extend a pass, and
 * block or unblock a wallet. Each needs a reason and is logged. None of it
 * moves money onchain: credits are RektBull's own ledger.
 */
const db = require('../config/db');
const credits = require('../payments/credits');
const settings = require('./settings');

const MAX_CREDIT_CENTS = 50000; // $500 an action
const MAX_PASS_DAYS = 365;
const refused = (m, status = 400) => Object.assign(new Error(m), { status });
const blockKey = wallet => `blocked:${wallet}`;
const { isSolanaAddress } = require('../lib/base58');

/** Is this wallet blocked? From the minute-old copy (sign-in reads the database). */
const isBlocked = wallet => !!(wallet && settings.get(blockKey(String(wallet).toLowerCase())));

async function find(query) {
  const raw = String(query || '').trim();
  const q = raw.toLowerCase();
  const sol = isSolanaAddress(raw);
  if (!/^0x[0-9a-f]{40}$/.test(q) && !/^\d+$/.test(q) && !sol) throw refused('Search by wallet address (0x… or a Solana address) or account number.');
  const cols = 'id, wallet, solana_wallet, created_at';
  const { rows } = await db.query(
    /^\d+$/.test(q) ? `SELECT ${cols} FROM accounts WHERE id = $1` : sol ? `SELECT ${cols} FROM accounts WHERE solana_wallet = $1` : `SELECT ${cols} FROM accounts WHERE wallet = $1`,
    [sol ? raw : q],
  );
  if (!rows.length) throw refused('No account for that wallet: it has never signed in.', 404);
  return rows[0];
}

/** Everything the panel shows about one account. */
async function lookup(query) {
  const a = await find(query);
  const [balance, passRows, runs, ledger, watched, agents, channels, block] = await Promise.all([
    credits.balance(a.id),
    db.query('SELECT id, product, starts_at, ends_at FROM passes WHERE account_id = $1 ORDER BY ends_at DESC LIMIT 10', [a.id]),
    db.query(`SELECT r.id, r.product, r.payment_method, r.price_cents, r.status, r.error, r.created_at,
                     EXISTS (SELECT 1 FROM credit_ledger l WHERE l.ref = 'refund:' || r.id) AS refunded
                FROM runs r WHERE r.account_id = $1 ORDER BY r.created_at DESC LIMIT 25`, [a.id]),
    db.query('SELECT delta_cents, reason, ref, created_at FROM credit_ledger WHERE account_id = $1 ORDER BY created_at DESC LIMIT 25', [a.id]),
    db.query('SELECT count(*)::int AS n FROM monitored_wallets WHERE account_id = $1', [a.id]),
    db.query('SELECT agent, enabled FROM agent_settings WHERE account_id = $1', [a.id]),
    db.query('SELECT kind, label, verified_at IS NOT NULL AS verified, disabled_at IS NOT NULL AS disabled FROM alert_channels WHERE account_id = $1', [a.id]),
    Promise.all([a.wallet, a.solana_wallet].filter(Boolean).map(w => settings.read(blockKey(w.toLowerCase())))).then(bs => bs.find(Boolean) || null),
  ]);
  return {
    account: { ...a, credits_cents: balance, blocked: block ? { since: block.at, reason: block.reason } : null },
    passes: passRows.rows.map(p => ({ ...p, active: new Date(p.ends_at) > new Date() && new Date(p.starts_at) <= new Date() })),
    runs: runs.rows, ledger: ledger.rows, watched_wallets: watched.rows[0].n,
    agents: agents.rows, alert_channels: channels.rows,
  };
}

async function addCredits(query, cents, { wallet, reason }) {
  const a = await find(query);
  if (!Number.isInteger(cents) || cents < 1 || cents > MAX_CREDIT_CENTS) throw refused(`cents must be a whole number from 1 to ${MAX_CREDIT_CENTS}: at most $${MAX_CREDIT_CENTS / 100} an action.`);
  const ref = `admin:${a.id}:${Date.now()}`;
  await credits.add(a.id, cents, 'adjustment', ref);
  await settings.note({ wallet, action: 'add_credits', key: `account:${a.id}`, after: { cents, ref }, reason });
  return { credits_cents: await credits.balance(a.id) };
}

/** Gives back what a run cost in credits, once. Only for runs paid with credits. */
async function refundRun(query, runId, { wallet, reason }) {
  const a = await find(query);
  if (!/^[0-9a-f-]{36}$/i.test(String(runId))) throw refused('No such run.', 404);
  const { rows: [r] } = await db.query('SELECT id, product, payment_method, price_cents, status FROM runs WHERE id = $1 AND account_id = $2', [runId, a.id]);
  if (!r) throw refused('No such run on this account.', 404);
  if (r.payment_method !== 'credits') throw refused(`This run was paid with ${r.payment_method === 'x402' ? 'x402 (USDC, outside RektBull\'s ledger: refund it from the fee wallet if you must)' : r.payment_method}; only credits can be refunded here.`);
  if (r.status === 'failed') throw refused('A failed run was never charged.');
  const added = await credits.add(a.id, r.price_cents, 'refund', `refund:${r.id}`);
  if (!added) throw refused('Already refunded.', 409);
  await settings.note({ wallet, action: 'refund_run', key: `account:${a.id}`, before: { run: r.id, product: r.product }, after: { cents: r.price_cents }, reason });
  return { refunded_cents: r.price_cents, credits_cents: await credits.balance(a.id) };
}

/** Adds days to the account's latest Safety Pro pass, or starts one now. */
async function extendPass(query, days, { wallet, reason }) {
  const a = await find(query);
  if (!Number.isInteger(days) || days < 1 || days > MAX_PASS_DAYS) throw refused(`days must be a whole number from 1 to ${MAX_PASS_DAYS}.`);
  const { rows } = await db.query(
    `INSERT INTO passes (account_id, product, starts_at, ends_at)
     SELECT $1, 'pro_30d', s, s + make_interval(days => $2)
     FROM (SELECT GREATEST(now(), COALESCE(MAX(ends_at), now())) AS s FROM passes WHERE account_id = $1) t
     RETURNING starts_at, ends_at`,
    [a.id, days],
  );
  await settings.note({ wallet, action: 'extend_pass', key: `account:${a.id}`, after: { days, until: rows[0].ends_at }, reason });
  return { pass_until: rows[0].ends_at };
}

/** A blocked wallet can't sign in, and its existing sessions stop working within a minute. */
async function setBlocked(query, blocked, { wallet, reason }) {
  if (typeof blocked !== 'boolean') throw refused('blocked must be true or false.');
  // A wallet given directly is blocked even if it never signed in; an account number blocks the account's wallets.
  const raw = String(query || '').trim();
  const direct = /^0x[0-9a-f]{40}$/i.test(raw) || isSolanaAddress(raw);
  const targets = direct ? [raw.toLowerCase()] : await find(query).then(a => [a.wallet, a.solana_wallet].filter(Boolean).map(w => w.toLowerCase()));
  const target = targets[0];
  if (targets.some(t => require('../config/env').adminWallets.includes(t))) throw refused('An admin wallet can\'t be blocked here; remove it from ADMIN_WALLETS first.');
  for (const t of targets) await settings.set(blockKey(t), blocked ? { at: new Date().toISOString(), reason } : null, { wallet, action: blocked ? 'block' : 'unblock', reason });
  return { wallet: target, wallets: targets, blocked };
}

module.exports = { lookup, addCredits, refundRun, extendPass, setBlocked, isBlocked, MAX_CREDIT_CENTS, MAX_PASS_DAYS };

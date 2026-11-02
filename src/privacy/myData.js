/**
 * A signed-in user's own data: download all of it, or delete what can be
 * deleted. Only a normal sign-in can do either (an extension token can't).
 *
 * Deleting removes: the email address, alert channels (Telegram, email,
 * push) and their delivery records, risk monitor wallets and alerts,
 * extension links, trading safety settings, free-use counters and pending
 * codes. It keeps what other records depend on, tied to the wallet address:
 * credits, top-ups, deposits, passes, paid runs, claims, and trades made through
 * RektBull (a payment or trade record has to say who it was for). Anything
 * onchain is public and can't be deleted by anyone.
 */
const db = require('../config/db');

class DataRefused extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const TABLES = {
  credit_ledger: 'SELECT delta_cents, reason, ref, created_at FROM credit_ledger WHERE account_id = $1 ORDER BY created_at',
  invoices: 'SELECT id, status, chain, token, amount_cents, paid_cents, deposit_address, product, created_at, expires_at FROM invoices WHERE account_id = $1 ORDER BY created_at',
  deposits: 'SELECT chain, token, tx_hash, from_address, amount_cents, status, seen_at, credited_at FROM deposits WHERE account_id = $1 ORDER BY seen_at',
  passes: 'SELECT product, starts_at, ends_at FROM passes WHERE account_id = $1 ORDER BY starts_at',
  runs: 'SELECT product, payment_method, price_cents, status, input, created_at FROM runs WHERE account_id = $1 ORDER BY created_at',
  monthly_counters: `SELECT key, period, allowance, used FROM period_usage WHERE subject = 'account:' || $1 ORDER BY period`,
  trade_settings: 'SELECT * FROM trade_settings WHERE account_id = $1',
  trade_proposals: 'SELECT * FROM trade_proposals WHERE account_id = $1 ORDER BY created_at',
  positions: 'SELECT chain, token, amount_raw, cost_usd, updated_at FROM positions WHERE account_id = $1',
  trade_permissions: 'SELECT id, wallet, chain_id, wallet_type, router, delegate, expires_at, status, created_at, revoked_at FROM trade_permissions WHERE account_id = $1',
  trade_intents: 'SELECT * FROM trade_intents WHERE account_id = $1 ORDER BY created_at',
  monitored_wallets: 'SELECT wallet, label, created_at, last_checked_at FROM monitored_wallets WHERE account_id = $1',
  monitor_alerts: 'SELECT wallet, kind, severity, title, detail, created_at, read_at FROM monitor_alerts WHERE account_id = $1 ORDER BY created_at',
  alert_channels: 'SELECT kind, label, target, min_severity, verified_at, disabled_at FROM alert_channels WHERE account_id = $1',
  extension_links: 'SELECT label, created_at, expires_at, last_used_at, revoked_at FROM extension_tokens WHERE account_id = $1',
  yield_moves: 'SELECT wallet, chain, asset, from_protocol, to_protocol, amount_raw, fee_raw, fee_bps, fee_wallet, status, tx_hashes, fee_paid_raw, created_at, confirmed_at FROM yield_moves WHERE account_id = $1 ORDER BY created_at',
  yield_permissions: 'SELECT wallet, chain_id, router, status, expires_at, created_at, revoked_at FROM yield_permissions WHERE account_id = $1',
  yield_auto_actions: 'SELECT a.kind, a.from_venue, a.to_venue, a.asset, a.amount_raw, a.reason, a.status, a.tx_hash, a.created_at FROM yield_auto_actions a JOIN yield_permissions p ON p.id = a.permission_id WHERE p.account_id = $1 ORDER BY a.created_at',
  claims: 'SELECT wallet, chain, items, fee_bps, fee_wallet, status, tx_hashes, received, fee_paid, created_at, confirmed_at FROM claims WHERE account_id = $1 ORDER BY created_at',
};

/** Everything RektBull holds about the account, as one JSON document. */
async function exportAll(account) {
  const { rows: [acct] } = await db.query('SELECT wallet, email, created_at FROM accounts WHERE id = $1', [account.id]);
  const out = { exported_at: new Date().toISOString(), account: acct };
  for (const [name, sql] of Object.entries(TABLES)) {
    try { out[name] = (await db.query(sql, [account.id])).rows; } catch (err) { out[name] = { not_exported: err.message }; }
  }
  return out;
}

/** Deletes the account's personal data that nothing else depends on. Returns what was removed. */
async function deleteMine(account, { confirm } = {}) {
  if (account.scope) throw new DataRefused('Sign in on rektbull.com to delete your data.', 403);
  if (confirm !== 'DELETE') throw new DataRefused('Type DELETE to confirm.');
  const { rows: active } = await db.query(`SELECT count(*)::int AS n FROM trade_permissions WHERE account_id = $1 AND status = 'active' AND expires_at > now()`, [account.id]);
  if (active[0].n) throw new DataRefused('Stop automatic trading first (on the Trade page, "Stop all automatic trading"), so no permission is left running.', 409);
  const { rows: yieldActive } = await db.query(`SELECT count(*)::int AS n FROM yield_permissions WHERE account_id = $1 AND status = 'active' AND expires_at > now()`, [account.id]);
  if (yieldActive[0].n) throw new DataRefused('Stop automatic yield rebalancing first, so no permission is left running.', 409);
  return db.tx(async c => {
    const removed = {};
    const run = async (name, sql) => { removed[name] = (await c.query(sql, [account.id])).rowCount; };
    await run('alert_channels', 'DELETE FROM alert_channels WHERE account_id = $1'); // with their deliveries
    await run('alert_link_codes', 'DELETE FROM alert_link_codes WHERE account_id = $1');
    await run('monitor_alerts', 'DELETE FROM monitor_alerts WHERE account_id = $1');
    await run('monitored_wallets', 'DELETE FROM monitored_wallets WHERE account_id = $1');
    const { rows: links } = await c.query('DELETE FROM extension_tokens WHERE account_id = $1 RETURNING jti', [account.id]);
    removed.extension_links = links.length;
    require('../auth/extensionTokens').forget(links.map(l => l.jti)); // stop them working at once
    await run('trade_settings', 'DELETE FROM trade_settings WHERE account_id = $1');
    await run('free_use_counters', `DELETE FROM free_usage WHERE subject = 'account:' || $1`);
    await run('email', 'UPDATE accounts SET email = NULL WHERE id = $1 AND email IS NOT NULL');
    return { removed, kept: 'Credits, top-ups, deposits, passes, paid runs, claims and yield moves (with their fees) and trades stay, tied to your wallet address: they are records of payments and trades. Anything onchain is public and permanent.' };
  });
}

module.exports = { exportAll, deleteMine, DataRefused };

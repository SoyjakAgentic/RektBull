/**
 * The risk monitor (part of Safety Pro). For each watched wallet, once a day
 * (SAFETY_PRO.monitor.every_hours), it runs a fresh approval scan and
 * compares it with what the previous check saw:
 *
 *   - new_approval: an approval that wasn't open before, rated medium or worse;
 *   - spender_flagged: an approval already open whose rating rose to high or
 *     critical (for example, GoPlus has since flagged the spender);
 *   - spender_upgraded: a spender contract that holds an open approval had
 *     its code replaced (its EIP-1967 implementation changed);
 *   - depeg: a stablecoin the wallet holds trades away from $1.
 *
 * The first check of a wallet only says what is open now (watching_started).
 * A chain that couldn't be read keeps what the previous check saw, so it
 * never makes everything look new the day it comes back. Each alert carries
 * the reasons and their sources; the same thing is never alerted twice.
 * Monitoring pauses while the account has no active Safety Pro.
 */
const db = require('../config/db');
const logger = require('../config/logger');
const approvals = require('./approvals');
const rpc = require('../providers/rpc');
const prices = require('../providers/prices');
const passes = require('../payments/passes');
const { SAFETY_PRO } = require('../payments/catalog');
const { STABLECOINS } = require('../payments/stablecoins');
const { ethers } = require('ethers');

const RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // EIP-1967
const MAX_SPENDERS_READ = 30;
const DEPEG = { low: 0.97, high: 1.03 };
const PER_TICK = 10;
const RETRY_MINUTES = 60;
const myAgents = () => require('./myAgents'); // the switch and schedule set on the AI agents page
const ERC20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);

/** The EIP-1967 implementation of a contract, or null when it isn't such a proxy. */
async function implementationOf(chain, address) {
  const raw = await rpc.evmRpc(chain, 'eth_getStorageAt', [address, IMPLEMENTATION_SLOT, 'latest']);
  const impl = '0x' + String(raw || '').slice(-40);
  return /^0x0{40}$/.test(impl) || impl.length !== 42 ? null : impl.toLowerCase();
}

/** Stablecoins the wallet holds (at least $1 worth), with their price now; chains not covered are skipped. */
async function stablecoinHoldings(owner, chains) {
  const held = [];
  for (const chain of chains) {
    for (const [symbol, t] of Object.entries(STABLECOINS[chain]?.tokens || {})) {
      try {
        const raw = await rpc.evmRpc(chain, 'eth_call', [{ to: t.address, data: ERC20.encodeFunctionData('balanceOf', [owner]) }, 'latest']);
        const amount = Number(ethers.formatUnits(BigInt(raw), t.decimals));
        if (amount >= 1) held.push({ chain, symbol, address: t.address, amount });
      } catch { /* not readable now: no depeg alert from it */ }
    }
  }
  if (!held.length) return held;
  const p = await prices.usdPrices(held.map(h => `${h.chain}:${h.address}`)).catch(() => ({}));
  return held.map(h => ({ ...h, price: p[`${h.chain}:${h.address}`] ?? null }));
}

/** What a check sees now: open approvals by key, spender implementations, stablecoins held. */
async function look(owner) {
  const scan = await approvals.scan(owner, { refresh: true });
  const read = scan.chains.filter(c => c.read).map(c => c.chain);
  const open = {};
  for (const c of scan.chains.filter(x => x.read)) {
    for (const a of c.approvals) open[`${c.chain}:${a.id}`] = { chain: c.chain, ...a };
  }
  const contracts = [...new Map(Object.values(open).filter(a => a.spender.is_wallet === false).map(a => [`${a.chain}:${a.spender.address}`, a])).values()];
  const impls = {};
  for (const a of contracts.slice(0, MAX_SPENDERS_READ)) {
    try { impls[`${a.chain}:${a.spender.address}`] = await implementationOf(a.chain, a.spender.address); } catch { /* unknown this time */ }
  }
  const stables = await stablecoinHoldings(owner, read.filter(c => STABLECOINS[c]));
  return { scan, read, open, impls, stables, unread: scan.chains.filter(c => !c.read).map(c => ({ chain: c.chain, reason: c.reason })) };
}

const brief = a => ({
  chain: a.chain, kind: a.kind, token: a.token, spender: a.spender, allowance: a.allowance,
  value_at_risk_usd: a.value_at_risk_usd, severity: a.severity, reasons: a.reasons,
});
const short = x => (x && x.length > 12 ? `${x.slice(0, 6)}…${x.slice(-4)}` : x);
const name = a => `${a.spender.label || short(a.spender.address)} on ${a.token.symbol || short(a.token.address)} (${a.chain})`;

/** Compares now with the previous snapshot: the alerts to raise, and the snapshot to keep. */
function compare(prev, now, today = new Date().toISOString().slice(0, 10)) {
  const alerts = [];
  const approvalsNow = {};
  const implsNow = {};
  // Chains not read now keep what the previous check saw.
  for (const [k, v] of Object.entries(prev?.approvals || {})) if (!now.read.includes(v.chain)) approvalsNow[k] = v;
  for (const [k, v] of Object.entries(prev?.impls || {})) if (!now.read.includes(k.split(':')[0])) implsNow[k] = v;
  for (const [k, a] of Object.entries(now.open)) approvalsNow[k] = { chain: a.chain, severity: a.severity, spender: a.spender.address };
  Object.assign(implsNow, now.impls);

  if (!prev) {
    const risky = Object.values(now.open).filter(a => RANK[a.severity] >= RANK.medium);
    alerts.push({
      kind: 'watching_started', severity: risky.some(a => RANK[a.severity] >= RANK.high) ? 'high' : 'info', dedupe: 'started',
      title: risky.length ? `Watching started: ${risky.length} risky approval${risky.length === 1 ? ' is' : 's are'} open now` : 'Watching started: no risky approvals open',
      detail: { open: Object.keys(now.open).length, risky: risky.map(brief), chains_read: now.read, chains_not_read: now.unread },
    });
  } else {
    for (const [k, a] of Object.entries(now.open)) {
      const before = prev.approvals?.[k];
      const chainWasRead = (prev.read || []).includes(a.chain);
      if (!before && chainWasRead && RANK[a.severity] >= RANK.medium) {
        alerts.push({ kind: 'new_approval', severity: a.severity, dedupe: `new:${k}`, title: `New ${a.severity}-risk approval: ${name(a)}`, detail: brief(a) });
      } else if (before && RANK[a.severity] > RANK[before.severity] && RANK[a.severity] >= RANK.high) {
        alerts.push({ kind: 'spender_flagged', severity: a.severity, dedupe: `flag:${k}:${a.severity}`, title: `An approval became ${a.severity} risk: ${name(a)}`, detail: { ...brief(a), was: before.severity } });
      }
    }
    for (const [k, impl] of Object.entries(now.impls)) {
      const was = prev.impls?.[k];
      if (was && impl && was !== impl) {
        const a = Object.values(now.open).find(x => `${x.chain}:${x.spender.address}` === k);
        alerts.push({
          kind: 'spender_upgraded', severity: 'high', dedupe: `upgrade:${k}:${impl}`,
          title: `A contract you approved had its code replaced: ${a ? name(a) : k}`,
          detail: { ...(a ? brief(a) : {}), implementation_was: was, implementation_now: impl, source: 'RPC (EIP-1967 implementation slot)', reasons: [{ text: 'Whoever controls the upgrade can change what it does with your approved tokens. Revoke unless you know why it changed.', source: 'RPC (EIP-1967 implementation slot)' }] },
        });
      }
    }
  }
  for (const s of now.stables) {
    if (s.price !== null && (s.price < DEPEG.low || s.price > DEPEG.high)) {
      alerts.push({
        kind: 'depeg', severity: s.price < 0.9 ? 'critical' : 'high', dedupe: `depeg:${s.chain}:${s.address}:${today}`,
        title: `${s.symbol} on ${s.chain} is at $${s.price.toFixed(4)}`,
        detail: { ...s, source: 'DefiLlama', reasons: [{ text: `You hold ${s.amount.toLocaleString()} ${s.symbol}; it is trading ${s.price < 1 ? 'below' : 'above'} $1.`, source: 'DefiLlama price; balance from RPC' }] },
      });
    }
  }
  const risky = Object.values(now.open).filter(a => RANK[a.severity] >= RANK.medium);
  return {
    alerts,
    snapshot: {
      approvals: approvalsNow, impls: implsNow, read: [...new Set([...(prev?.read || []), ...now.read])],
      summary: { open: Object.keys(now.open).length, risky: risky.length, value_at_risk_usd: Math.round(risky.reduce((t, a) => t + (a.value_at_risk_usd || 0), 0) * 100) / 100, chains_not_read: now.unread },
      checked_at: new Date().toISOString(),
    },
  };
}

/** Checks one watched wallet now and stores its alerts. Returns the alerts raised. */
async function check(row) {
  const now = await module.exports.look(row.wallet);
  const { alerts, snapshot } = compare(row.snapshot, now);
  const raised = [];
  for (const a of alerts) {
    const { rows } = await db.query(
      `INSERT INTO monitor_alerts (account_id, wallet_id, wallet, kind, severity, title, detail, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (account_id, dedupe_key) DO NOTHING RETURNING id`,
      [row.account_id, row.id, row.wallet, a.kind, a.severity, a.title, JSON.stringify(a.detail), `${row.wallet}:${a.dedupe}`],
    );
    if (rows.length) raised.push({ id: rows[0].id, ...a });
  }
  if (raised.length) await require('../alerts/dispatch').enqueue(raised.map(a => a.id)); // to Telegram, email, push
  await db.query(
    `UPDATE monitored_wallets SET snapshot = $2, last_checked_at = now(), last_error = NULL,
       next_check_at = now() + make_interval(hours => $3) WHERE id = $1`,
    [row.id, JSON.stringify(snapshot), await myAgents().everyHours(row.account_id, 'wallet_guardian')],
  );
  return raised;
}

/** The worker's job: check the wallets that are due, a few at a time. Paused without Safety Pro. */
async function tick({ limit = PER_TICK } = {}) {
  const { rows } = await db.query('SELECT * FROM monitored_wallets WHERE next_check_at <= now() ORDER BY next_check_at LIMIT $1', [limit]);
  for (const row of rows) {
    if (!(await passes.covering(row.account_id, 'risk_monitor'))) {
      await db.query(`UPDATE monitored_wallets SET last_error = 'Paused: Safety Pro has ended', next_check_at = now() + interval '1 day' WHERE id = $1`, [row.id]);
      continue;
    }
    if (!(await myAgents().isOn(row.account_id, 'wallet_guardian'))) {
      await db.query(`UPDATE monitored_wallets SET last_error = 'Paused: Wallet Guardian is switched off on the AI agents page', next_check_at = now() + interval '1 day' WHERE id = $1`, [row.id]);
      continue;
    }
    try {
      await check(row);
    } catch (err) {
      logger.warn('monitor check failed', { wallet: row.wallet, error: err.message });
      await db.query(`UPDATE monitored_wallets SET last_error = $2, next_check_at = now() + make_interval(mins => $3) WHERE id = $1`, [row.id, err.message.slice(0, 300), RETRY_MINUTES]);
    }
  }
  return rows.length;
}

const present = r => ({
  id: r.id, wallet: r.wallet, label: r.label, created_at: r.created_at, last_checked_at: r.last_checked_at,
  next_check_at: r.next_check_at, last_error: r.last_error, summary: r.snapshot?.summary || null,
});

async function list(accountId) {
  const pass = await passes.covering(accountId, 'risk_monitor');
  const { rows } = await db.query('SELECT * FROM monitored_wallets WHERE account_id = $1 ORDER BY created_at', [accountId]);
  const unread = await db.query('SELECT count(*)::int AS n FROM monitor_alerts WHERE account_id = $1 AND read_at IS NULL', [accountId]);
  return { active: !!pass, ...(pass ? { until: pass.ends_at } : {}), limit: SAFETY_PRO.monitor.wallets, every_hours: await myAgents().everyHours(accountId, 'wallet_guardian'), switched_on: await myAgents().isOn(accountId, 'wallet_guardian'), wallets: rows.map(present), unread_alerts: unread.rows[0].n };
}

class MonitorRefused extends Error {
  constructor(message, status, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

/** Starts watching a wallet (Safety Pro only), and runs its first check now. */
async function watch(accountId, { wallet, label }) {
  const w = String(wallet || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(w)) throw new MonitorRefused('wallet must be a wallet address (0x and 40 hex characters)', 400);
  if (!(await passes.covering(accountId, 'risk_monitor'))) throw new MonitorRefused('The risk monitor is part of Safety Pro.', 402, { offer: 'pro_30d' });
  const { rows: count } = await db.query('SELECT count(*)::int AS n FROM monitored_wallets WHERE account_id = $1', [accountId]);
  if (count[0].n >= SAFETY_PRO.monitor.wallets) throw new MonitorRefused(`Safety Pro watches up to ${SAFETY_PRO.monitor.wallets} wallets; stop watching one first.`, 409);
  const { rows } = await db.query(
    `INSERT INTO monitored_wallets (account_id, wallet, label) VALUES ($1, $2, $3)
     ON CONFLICT (account_id, wallet) DO UPDATE SET label = COALESCE(EXCLUDED.label, monitored_wallets.label) RETURNING *`,
    [accountId, w.toLowerCase(), label ? String(label).slice(0, 60) : null],
  );
  let first = null;
  try { first = await check(rows[0]); } catch (err) {
    await db.query(`UPDATE monitored_wallets SET last_error = $2, next_check_at = now() + make_interval(mins => $3) WHERE id = $1`, [rows[0].id, err.message.slice(0, 300), RETRY_MINUTES]);
  }
  const { rows: again } = await db.query('SELECT * FROM monitored_wallets WHERE id = $1', [rows[0].id]);
  return { wallet: present(again[0]), alerts: first };
}

async function unwatch(accountId, id) {
  const { rowCount } = await db.query('DELETE FROM monitored_wallets WHERE id = $1 AND account_id = $2', [id, accountId]);
  if (!rowCount) throw new MonitorRefused('not found', 404);
  return { ok: true };
}

async function alerts(accountId, { unreadOnly = false } = {}) {
  const { rows } = await db.query(
    `SELECT id, wallet, kind, severity, title, detail, created_at, read_at FROM monitor_alerts
     WHERE account_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC, id DESC LIMIT 100`, [accountId]);
  return rows;
}

async function markRead(accountId, ids) {
  if (Array.isArray(ids) && ids.length) {
    await db.query('UPDATE monitor_alerts SET read_at = now() WHERE account_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL', [accountId, ids.map(Number)]);
  } else {
    await db.query('UPDATE monitor_alerts SET read_at = now() WHERE account_id = $1 AND read_at IS NULL', [accountId]);
  }
  return { ok: true };
}

module.exports = { tick, check, look, compare, list, watch, unwatch, alerts, markRead, implementationOf, MonitorRefused, IMPLEMENTATION_SLOT };

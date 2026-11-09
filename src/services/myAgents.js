/**
 * AI agents: the jobs that run for you, each with an on switch, a schedule
 * and alerts (Telegram, email, browser push, through src/alerts/dispatch).
 *
 * Every agent runs a check a desk already has; nothing is built twice. Three
 * agents are new schedules run here (the wallet checkup, the claim assistant
 * and the token watch). Four were already running elsewhere and only take
 * their switch (and, for the wallet guardian, its schedule) from here: the
 * wallet guardian (services/monitor), DAO votes (services/governance), the
 * yield watch (yield/risk) and the trading agent's exits (trade/exits).
 *
 * What an agent never does: decide a fact, sign, or move money. Alerts carry
 * the reasons with their sources; a check that couldn't run says so.
 */
const db = require('../config/db');
const logger = require('../config/logger');
const passes = require('../payments/passes');
const { SAFETY_PRO } = require('../payments/catalog');
const agentStates = require('../admin/agentStates');

class AgentsRefused extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const TOKEN_WATCH_MAX = 10;
const LAUNCH_SAFETY_MAX = 5;
/** The agents that take a token list, and how many tokens each holds. */
const TOKEN_LISTS = { token_watch: TOKEN_WATCH_MAX, launch_safety: LAUNCH_SAFETY_MAX };
const PER_TICK = 10;
const RETRY_MINUTES = 60;
const RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/**
 * The agents, in the order the page shows them.
 *   plan: 'free' (any signed-in wallet) or 'pro' (Safety Pro).
 *   every: the schedules a user can pick, in hours; fixed when there's one.
 *   runs_here: scheduled by this file's tick(); the others run where they always did.
 *   default_on: on without a row; the ones that ran before this tab existed stay on.
 */
const AGENTS = [
  {
    id: 'wallet_checkup', name: 'Wallet Checkup', was: 'Crypto Assistant', desk: { name: 'Home', href: '/' },
    does: 'Runs the free checkup on your wallet: approvals worth revoking, unclaimed rewards, idle stablecoins and ETH, and DAO votes. Sends you the result, with each part\'s source.',
    alerts: 'A summary after each run (weekly), or only when something changed (daily).',
    plan: 'free', every: [24, 168], default_every: 168, default_on: false, runs_here: true, wallets: 'signed_in',
  },
  {
    id: 'wallet_guardian', name: 'Wallet Guardian', was: 'Wallet Guardian', desk: { name: 'Safety', href: '/safety#monitor-card' },
    does: 'Watches up to 3 wallets for new risky approvals, spenders that get flagged, contracts you approved that had their code replaced, and stablecoins you hold going off peg.',
    alerts: 'Each new risk, once, with the reasons and their sources.',
    plan: 'pro', every: [12, 24], default_every: SAFETY_PRO.monitor.every_hours, default_on: true, runs_here: false, wallets: 'watched',
  },
  {
    id: 'claim_assistant', name: 'Claim Assistant', was: 'Airdrop Claim Assistant', desk: { name: 'Find money', href: '/find' },
    does: 'Re-checks your wallet for unclaimed airdrops and rewards (Merkl campaigns and the airdrops RektBull adds), each verified onchain. When you claim, your wallet signs.',
    alerts: 'When something new becomes claimable.',
    plan: 'free', every: [24, 168], default_every: 24, default_on: false, runs_here: true, wallets: 'signed_in_and_watched',
  },
  {
    id: 'token_watch', name: 'Token Watch', was: 'Pre-Trade Safety Check', desk: { name: 'Safety', href: '/safety#check-card' },
    does: `Re-checks up to ${TOKEN_WATCH_MAX} tokens you hold or plan to buy, every day: can it still be sold, did its tax or owner powers change, did GoPlus flag it.`,
    alerts: 'When a token gets a new medium, high or critical flag.',
    plan: 'pro', every: [24], default_every: 24, default_on: false, runs_here: true, wallets: 'none',
  },
  {
    id: 'launch_safety', name: 'Launch Safety', was: 'Launch Bundle Detector and Insider Wallet Tracer', desk: { name: 'Safety', href: '/safety#check-card' },
    does: `Checks up to ${LAUNCH_SAFETY_MAX} new tokens for a bundled launch: early buyers funded from the same wallet, links back to the deployer, and how much they bought. Then keeps watching those wallets.`,
    alerts: 'When a bundle is found, and when its wallets start selling.',
    plan: 'pro', every: [6, 24], default_every: 6, default_on: false, runs_here: true, wallets: 'none',
  },
  {
    id: 'dao_votes', name: 'DAO Votes', was: 'DAO Governance Digest', desk: { name: 'Governance', href: '/governance' },
    does: 'Watches the DAOs your watched wallets can vote in, on Snapshot and onchain governors, and writes a plain-English summary of any proposal on request.',
    alerts: 'When a vote opens that you can cast, and a day before it closes if you haven\'t voted.',
    plan: 'pro', every: [], default_every: 1, default_on: true, runs_here: false, wallets: 'watched',
  },
  {
    id: 'yield_watch', name: 'Yield Watch', was: 'Yield Rebalance Advisor', desk: { name: 'Find money', href: '/find#yield-card' },
    does: 'Watches the lending venues your watched wallets use (Aave v3, Compound v3, Spark) for exploits, runs, frozen markets and broken oracles. Proposals to move are prepared on the desk for your wallet to sign.',
    alerts: 'When a venue you hold turns risky, with "withdraw now" when it\'s critical.',
    plan: 'pro', every: [], default_every: 1 / 12, default_on: true, runs_here: false, wallets: 'watched',
  },
  {
    id: 'trading_agent', name: 'Trading Agent', was: 'Meme Coin Trader', desk: { name: 'Trade', href: '/trade' },
    does: 'Buys and sells within the limits your wallet signed onchain (a session key), and exits at your stop-loss or take-profit. It can only send the result back to your wallet.',
    alerts: 'When it sells a position at your stop-loss or take-profit.',
    plan: 'trade', every: [], default_every: null, default_on: true, runs_here: false, wallets: 'signed_in',
  },
];
const BY_ID = Object.fromEntries(AGENTS.map(a => [a.id, a]));

const scheduleText = h => (h === null ? 'When a trade or exit is due' : h < 1 ? 'Every 5 minutes' : h === 1 ? 'Every hour' : h === 168 ? 'Every week' : h === 24 ? 'Every day' : `Every ${h} hours`);

/**
 * The agents as the page and the API describe them (no account needed). Only
 * the listed ones, unless all: an admin can hide an agent or switch it off.
 */
function catalog({ all = false } = {}) {
  return AGENTS.filter(a => all || agentStates.listed(a.id)).map(a => ({
    id: a.id, name: a.name, was: a.was, does: a.does, alerts: a.alerts, desk: a.desk,
    plan: a.plan, price: a.plan === 'free' ? 'Free' : a.plan === 'pro' ? 'Safety Pro' : 'Trade desk fees',
    schedules: (a.every.length ? a.every : [a.default_every]).map(h => ({ every_hours: h, label: scheduleText(h) })),
    default_schedule: scheduleText(a.default_every),
    default_on: a.default_on,
    ...(all ? { state: agentStates.state(a.id) } : {}),
  }));
}

async function rowsFor(accountId) {
  const { rows } = await db.query('SELECT * FROM agent_settings WHERE account_id = $1', [accountId]);
  return Object.fromEntries(rows.map(r => [r.agent, r]));
}

/** Is the agent on for this account? (Rows win; no row means its default.) */
async function isOn(accountId, agentId) {
  if (agentStates.isOff(agentId)) return false;
  const { rows } = await db.query('SELECT enabled FROM agent_settings WHERE account_id = $1 AND agent = $2', [accountId, agentId]);
  return rows.length ? rows[0].enabled : BY_ID[agentId].default_on;
}

/** The hours between runs for this account (its choice, or the agent's default). */
async function everyHours(accountId, agentId) {
  const { rows } = await db.query('SELECT every_hours FROM agent_settings WHERE account_id = $1 AND agent = $2', [accountId, agentId]);
  return rows[0]?.every_hours ?? BY_ID[agentId].default_every;
}

/** Each agent with this account's switch, schedule, status and last run. */
async function list(accountId) {
  const [rows, pro, watched, unread, channels] = await Promise.all([
    rowsFor(accountId),
    passes.covering(accountId, 'risk_monitor'),
    db.query('SELECT count(*)::int AS n FROM monitored_wallets WHERE account_id = $1', [accountId]),
    db.query('SELECT count(*)::int AS n FROM monitor_alerts WHERE account_id = $1 AND read_at IS NULL', [accountId]),
    db.query('SELECT kind FROM alert_channels WHERE account_id = $1 AND verified_at IS NOT NULL AND disabled_at IS NULL', [accountId]),
  ]);
  const trading = await db.query(`SELECT count(*)::int AS n FROM trade_permissions WHERE account_id = $1 AND status = 'active'`, [accountId]).catch(() => ({ rows: [{ n: 0 }] }));
  // A hidden agent still shows for an account that uses it; one that's off shows as paused to an account that had it on.
  const agents = catalog({ all: true }).filter(c => c.state === 'active' || (rows[c.id]?.enabled ?? (BY_ID[c.id].default_on && c.state === 'off'))).map(c => {
    const a = BY_ID[c.id];
    const r = rows[c.id];
    const on = c.state === 'off' ? false : r ? r.enabled : a.default_on;
    const every = r?.every_hours ?? a.default_every;
    let status;
    if (c.state === 'off') status = { state: 'paused', text: 'Paused by RektBull for now; your settings are kept' };
    else if (a.plan === 'pro' && !pro) status = { state: 'needs_pro', text: 'Part of Safety Pro' };
    else if (a.wallets === 'watched' && !watched.rows[0].n) status = { state: 'needs_wallets', text: 'Watch a wallet on the Safety page first' };
    else if (a.id === 'trading_agent' && !trading.rows[0].n) status = { state: 'needs_setup', text: 'Set limits on the Trade desk first' };
    else if (TOKEN_LISTS[a.id] && !(r?.settings?.tokens || []).length) status = { state: 'needs_setup', text: 'Add a token to watch' };
    else status = on ? { state: 'on', text: 'On' } : { state: 'off', text: 'Off' };
    return {
      ...c, enabled: on, every_hours: every, schedule: scheduleText(every), status,
      ...(TOKEN_LISTS[a.id] ? { tokens: r?.settings?.tokens || [], max_tokens: TOKEN_LISTS[a.id] } : {}),
      last_run_at: r?.last_run_at || null, last_result: r?.last_result || null, last_error: r?.last_error || null,
      next_run_at: a.runs_here && on ? r?.next_run_at || null : null,
    };
  });
  return {
    agents, safety_pro: !!pro, ...(pro ? { pro_until: pro.ends_at } : {}), watched_wallets: watched.rows[0].n,
    unread_alerts: unread.rows[0].n, alert_channels: [...new Set(channels.rows.map(c => c.kind))],
  };
}

/* ── settings ── */

const TOKEN_RE = { evm: /^0x[0-9a-fA-F]{40}$/, solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ };

function parseTokens(list, max = TOKEN_WATCH_MAX, name = 'Token Watch') {
  const { SCAN_CHAINS } = require('./tokenRisk');
  if (!Array.isArray(list)) throw new AgentsRefused('tokens must be a list of { chain, token }.');
  if (list.length > max) throw new AgentsRefused(`${name} holds up to ${max} tokens.`);
  const seen = new Set();
  return list.map(t => {
    const chain = String(t?.chain || '').toLowerCase();
    const token = String(t?.token || '').trim();
    if (!SCAN_CHAINS.includes(chain)) throw new AgentsRefused(`chain must be one of: ${SCAN_CHAINS.join(', ')}.`);
    if (!(chain === 'solana' ? TOKEN_RE.solana : TOKEN_RE.evm).test(token)) throw new AgentsRefused(chain === 'solana' ? 'That isn\'t a Solana mint address.' : 'That isn\'t a token contract address (0x and 40 hex characters).');
    const key = `${chain}:${chain === 'solana' ? token : token.toLowerCase()}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { chain, token: chain === 'solana' ? token : token.toLowerCase(), ...(t.label ? { label: String(t.label).slice(0, 40) } : {}) };
  }).filter(Boolean);
}

/** Switches an agent on or off, sets its schedule, or (Token Watch) its tokens. */
async function update(accountId, agentId, body = {}) {
  const a = BY_ID[agentId];
  if (!a) throw new AgentsRefused('No such agent.', 404);
  if (agentStates.isOff(agentId)) throw new AgentsRefused(`${a.name} is paused by RektBull for now; your settings are kept.`, 503);
  const current = (await rowsFor(accountId))[agentId];
  const enabled = body.enabled === undefined ? (current ? current.enabled : a.default_on) : body.enabled;
  if (typeof enabled !== 'boolean') throw new AgentsRefused('enabled must be true or false.');
  let every = current?.every_hours ?? null;
  if (body.every_hours !== undefined) {
    const h = Number(body.every_hours);
    if (!a.every.includes(h) || a.every.length < 2) throw new AgentsRefused(a.every.length < 2 ? `${a.name}'s schedule is fixed: ${scheduleText(a.default_every).toLowerCase()}.` : `every_hours must be one of: ${a.every.join(', ')}.`);
    every = h;
  }
  const settings = { ...(current?.settings || {}) };
  if (body.tokens !== undefined) {
    if (!TOKEN_LISTS[agentId]) throw new AgentsRefused('Only Token Watch and Launch Safety take a token list.');
    settings.tokens = parseTokens(body.tokens, TOKEN_LISTS[agentId], a.name);
  }
  // Switching on a Safety Pro agent needs Safety Pro; switching off never does.
  if (body.enabled === true && a.plan === 'pro' && !(await passes.covering(accountId, 'risk_monitor'))) {
    throw new AgentsRefused(`${a.name} is part of Safety Pro.`, 402, { offer: 'pro_30d' });
  }
  // Switched on (or its schedule changed): runs-here agents run on the next tick.
  const runSoon = a.runs_here && enabled && (!current?.enabled || body.every_hours !== undefined || body.tokens !== undefined);
  await db.query(
    `INSERT INTO agent_settings (account_id, agent, enabled, every_hours, settings, next_run_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (account_id, agent) DO UPDATE SET enabled = $3, every_hours = $4, settings = $5, updated_at = now(),
       next_run_at = CASE WHEN $6 THEN now() ELSE agent_settings.next_run_at END`,
    [accountId, agentId, enabled, every, JSON.stringify(settings), runSoon],
  );
  if (agentId === 'wallet_guardian' && enabled && current && !current.enabled) {
    await db.query(`UPDATE monitored_wallets SET next_check_at = now(), last_error = NULL WHERE account_id = $1`, [accountId]);
  } else if (agentId === 'wallet_guardian' && body.every_hours !== undefined) {
    // The monitor's own schedule: the next check comes no later than the new interval.
    await db.query('UPDATE monitored_wallets SET next_check_at = LEAST(next_check_at, COALESCE(last_checked_at, now()) + make_interval(hours => $2)) WHERE account_id = $1', [accountId, every]);
  }
  return (await list(accountId)).agents.find(x => x.id === agentId);
}

/* ── raising alerts ── */

async function raise(accountId, alerts) {
  const ids = [];
  for (const a of alerts) {
    const { rows } = await db.query(
      `INSERT INTO monitor_alerts (account_id, wallet, kind, severity, title, detail, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (account_id, dedupe_key) DO NOTHING RETURNING id`,
      [accountId, a.wallet, a.kind, a.severity, a.title.slice(0, 200), JSON.stringify(a.detail || {}), a.dedupe],
    );
    if (rows.length) ids.push(rows[0].id);
  }
  if (ids.length) await require('../alerts/dispatch').enqueue(ids);
  return ids.length;
}

/* ── the agents that run here ── */

const RUNNERS = {
  /** The free checkup on the signed-in wallet. Weekly: a summary every run. Daily: only when the headlines changed. */
  async wallet_checkup({ account, row, every }) {
    const r = await require('./home').checkup(account.wallet, { accountId: account.id });
    const headlines = r.parts.map(p => `${p.id}:${p.status}:${p.headline}`).sort().join('|');
    const actionable = r.parts.filter(p => ['bad', 'warn', 'good'].includes(p.status));
    const unknown = r.parts.filter(p => !p.ok);
    const changed = row?.snapshot?.headlines !== headlines;
    const alerts = [];
    if (every >= 168 || changed) {
      const worst = r.parts.some(p => p.status === 'bad') ? 'high' : actionable.length ? 'medium' : 'low';
      alerts.push({
        kind: 'checkup', severity: worst, dedupe: `checkup:${account.wallet}:${r.checked_at.slice(0, 13)}`,
        title: actionable.length ? `Your wallet checkup: ${actionable.map(p => p.headline.charAt(0).toLowerCase() + p.headline.slice(1)).join('; ')}` : 'Your wallet checkup: nothing to act on in the sources checked',
        detail: {
          reasons: [
            ...r.parts.filter(p => p.ok).map(p => ({ text: `${p.title}: ${p.headline}.`, source: p.source })),
            ...unknown.map(p => ({ text: `${p.title}: couldn't be checked (${p.reason}).`, source: 'RektBull' })),
          ],
          parts: r.parts.map(p => ({ id: p.id, status: p.status, headline: p.headline, href: p.href })),
        },
      });
    }
    return {
      alerts: alerts.map(a => ({ ...a, wallet: account.wallet })),
      snapshot: { headlines },
      result: { text: r.parts.map(p => `${p.title}: ${p.headline}`).join(' · '), not_checked: unknown.map(p => p.title) },
    };
  },

  /** New claimable rewards on the signed-in wallet and the watched ones. Each item is alerted once per amount. */
  async claim_assistant({ account, row }) {
    const wallets = await walletsFor(account, 'signed_in_and_watched');
    const claims = require('./claims');
    const seen = { ...(row?.snapshot?.seen || {}) };
    const alerts = [];
    const notChecked = [];
    let claimable = 0, usd = 0;
    for (const w of wallets) {
      let c;
      try { c = await claims.check(w, { accountId: account.id }); } catch (err) { notChecked.push(`${w}: ${err.message}`); continue; }
      for (const n of c.not_checked) notChecked.push(`${n.check} (${n.reason})`);
      for (const i of c.items.filter(x => x.status === 'claimable')) {
        claimable++; usd += i.claimable_usd || 0;
        const key = `${w}:${i.id}`;
        const amount = String(i.claimable_raw ?? '');
        if (seen[key] === amount) continue;
        seen[key] = amount;
        const worth = i.claimable_usd ? ` worth $${i.claimable_usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
        alerts.push({
          kind: 'claimable', severity: 'medium', wallet: w, dedupe: `claim:${key}:${amount}`,
          title: `You can claim ${i.name}${worth}`,
          detail: { reasons: [{ text: `${i.name} on ${claims.CHAIN_NAMES?.[i.chain] || i.chain}, verified onchain. Claim from your own wallet; checking is free.`, source: i.source_label }], item: { id: i.id, chain: i.chain } },
        });
      }
    }
    return {
      alerts, snapshot: { seen },
      result: { text: claimable ? `${claimable} unclaimed${usd ? ` worth $${Math.round(usd * 100) / 100}` : ''} across ${wallets.length} wallet${wallets.length === 1 ? '' : 's'}` : `Nothing unclaimed in the sources checked (${wallets.length} wallet${wallets.length === 1 ? '' : 's'})`, not_checked: notChecked.slice(0, 10) },
    };
  },

  /** Each watched token re-scanned; a flag of medium or worse that wasn't there last time is alerted. */
  async token_watch({ account, row }) {
    const tokens = row?.settings?.tokens || [];
    const { scanToken } = require('./tokenRisk');
    const prev = row?.snapshot?.flags || {};
    const now = {};
    const alerts = [];
    const notChecked = [];
    for (const t of tokens) {
      const key = `${t.chain}:${t.token}`;
      let s;
      try { s = await scanToken({ chain: t.chain, token_address: t.token }); } catch (err) { notChecked.push(`${t.label || key}: ${err.message}`); if (prev[key]) now[key] = prev[key]; continue; }
      if (s.error) { notChecked.push(`${t.label || key}: ${s.error}`); continue; }
      if (s.incomplete) notChecked.push(`${t.label || key}: ${s.incomplete}`);
      const flags = s.flags.filter(f => RANK[f.severity] >= RANK.medium);
      now[key] = flags.map(f => `${f.id}:${f.severity}`);
      const before = new Set(prev[key] || []);
      const fresh = flags.filter(f => !before.has(`${f.id}:${f.severity}`));
      // The first scan of a token only records what's there; a later one alerts what's new.
      if (!prev[key] || !fresh.length) continue;
      const worst = fresh.reduce((w, f) => (RANK[f.severity] > RANK[w] ? f.severity : w), 'medium');
      alerts.push({
        kind: 'token_watch', severity: worst, wallet: account.wallet,
        dedupe: `token:${key}:${fresh.map(f => `${f.id}:${f.severity}`).sort().join(',')}`,
        title: `${t.label || `${t.token.slice(0, 6)}…${t.token.slice(-4)}`} on ${t.chain}: ${fresh[0].title}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`,
        detail: { reasons: fresh.slice(0, 4).map(f => ({ text: `${f.title}. ${f.evidence || ''}`.trim(), source: f.source })), token: { chain: t.chain, token: t.token } },
      });
    }
    const flagged = Object.values(now).filter(f => f.length).length;
    return {
      alerts, snapshot: { flags: now },
      result: { text: `${tokens.length} token${tokens.length === 1 ? '' : 's'} checked, ${flagged} with a medium or worse flag`, not_checked: notChecked.slice(0, 10) },
    };
  },

  /**
   * Each token's launch checked once (src/services/launchSafety.js); a bundle found is alerted.
   * After that, only what the flagged groups hold is read again: wallets that sold another 20% or
   * more of what they bought at launch are alerted.
   */
  async launch_safety({ account, row }) {
    const ls = require('./launchSafety');
    const tokens = row?.settings?.tokens || [];
    const prev = row?.snapshot?.launches || {};
    const now = {};
    const alerts = [];
    const notChecked = [];
    const nameOf = t => t.label || `${t.token.slice(0, 6)}…${t.token.slice(-4)}`;
    for (const t of tokens) {
      const key = `${t.chain}:${t.token}`;
      const token = { chain: t.chain, token: t.token };
      try {
        if (!prev[key]) {
          const r = await ls.check(token);
          const groups = r.groups.filter(g => g.funder_kind !== 'busy' && g.bought_pct >= 3)
            .map(g => ({ funder: g.funder, wallets: g.wallets.map(w => ({ address: w.address })), bought_pct: g.bought_pct, holds_pct: g.holds_pct, reported_pct: g.holds_pct }));
          now[key] = { verdict: r.verdict, groups };
          if (r.verdict !== 'no_bundle_found') {
            alerts.push({
              kind: 'launch_safety', severity: r.verdict === 'bundle_found' ? 'high' : 'medium', wallet: account.wallet, dedupe: `launch:${key}:found`,
              title: `${nameOf(t)} on ${t.chain}: ${r.summary.replace(/\.$/, '')}`,
              detail: { reasons: r.flags.filter(f => f.severity !== 'info').slice(0, 4).map(f => ({ text: `${f.title}. ${f.evidence}`, source: f.source })), token },
            });
          }
          continue;
        }
        const p = { ...prev[key], groups: prev[key].groups.map(g => ({ ...g })) };
        now[key] = p;
        if (!p.groups.length) continue;
        const holds = await ls.holdingsNow(t.chain, t.token, p.groups);
        for (const g of p.groups) {
          const h = holds[g.funder];
          if (h === null || h === undefined || !g.bought_pct) continue;
          // Compared with what they held when last reported, so slow selling adds up to an alert too.
          const reported = g.reported_pct ?? g.holds_pct;
          const soldBefore = reported === null || reported === undefined ? 0 : Math.max(0, Math.round((1 - reported / g.bought_pct) * 100));
          const soldNow = Math.max(0, Math.round((1 - h / g.bought_pct) * 100));
          if (soldNow - soldBefore >= 20) {
            alerts.push({
              kind: 'launch_safety', severity: 'critical', wallet: account.wallet, dedupe: `launch:${key}:${g.funder}:sold:${Math.floor(soldNow / 20)}`,
              title: `${nameOf(t)} on ${t.chain}: bundle wallets are selling (${soldNow}% of what they bought at launch is gone)`,
              detail: { reasons: [{ text: `${g.wallets.length} wallets funded from ${g.funder.slice(0, 6)}…${g.funder.slice(-4)} bought ${g.bought_pct}% of the supply at launch and hold ${h}% now (${reported ?? 'unknown'}% when last reported).`, source: t.chain === 'solana' ? 'Solana RPC' : `${t.chain} RPC (balanceOf)` }], token },
            });
            g.reported_pct = h;
          }
          g.holds_pct = h;
        }
      } catch (err) {
        notChecked.push(`${nameOf(t)}: ${err.message}`);
        if (prev[key]) now[key] = prev[key];
      }
    }
    const bundles = Object.values(now).filter(x => x.verdict !== 'no_bundle_found').length;
    return {
      alerts, snapshot: { launches: now },
      result: { text: `${tokens.length} token${tokens.length === 1 ? '' : 's'} watched, ${bundles} with a bundle or possible bundle`, not_checked: notChecked.slice(0, 10) },
    };
  },
};

async function walletsFor(account, which) {
  const own = [account.wallet.toLowerCase()];
  if (which === 'signed_in') return own;
  if (!(await passes.covering(account.id, 'risk_monitor'))) return own;
  const { rows } = await db.query('SELECT wallet FROM monitored_wallets WHERE account_id = $1', [account.id]);
  return [...new Set([...own, ...rows.map(r => r.wallet.toLowerCase())])];
}

/** Runs one agent for one account now, stores what it saw and raises its alerts. */
async function runOne(row) {
  const a = BY_ID[row.agent];
  const { rows: [account] } = await db.query('SELECT id, wallet FROM accounts WHERE id = $1', [row.account_id]);
  const every = row.every_hours ?? a.default_every;
  if (a.plan === 'pro' && !(await passes.covering(row.account_id, 'risk_monitor'))) {
    await db.query(`UPDATE agent_settings SET last_error = 'Paused: Safety Pro has ended', next_run_at = now() + interval '1 day' WHERE account_id = $1 AND agent = $2`, [row.account_id, row.agent]);
    return { paused: true };
  }
  const out = await RUNNERS[row.agent]({ account, row, every });
  const raised = await raise(account.id, out.alerts.map(x => ({ ...x, wallet: x.wallet || account.wallet })));
  await db.query(
    `UPDATE agent_settings SET snapshot = $3, last_result = $4, last_run_at = now(), last_error = NULL,
       next_run_at = now() + make_interval(hours => $5) WHERE account_id = $1 AND agent = $2`,
    [row.account_id, row.agent, JSON.stringify(out.snapshot), JSON.stringify({ ...out.result, alerts: raised }), every],
  );
  return { alerts: raised, result: out.result };
}

/** The worker's job: run the agents that are due, a few at a time. */
async function tick({ limit = PER_TICK } = {}) {
  const ids = Object.keys(RUNNERS).filter(id => !agentStates.isOff(id));
  if (!ids.length) return 0;
  const { rows } = await db.query(
    'SELECT * FROM agent_settings WHERE enabled AND agent = ANY($1::text[]) AND next_run_at <= now() ORDER BY next_run_at LIMIT $2',
    [ids, limit],
  );
  for (const row of rows) {
    try { await runOne(row); } catch (err) {
      logger.warn('agent run failed', { agent: row.agent, account: row.account_id, error: err.message });
      await db.query('UPDATE agent_settings SET last_error = $3, next_run_at = now() + make_interval(mins => $4) WHERE account_id = $1 AND agent = $2', [row.account_id, row.agent, err.message.slice(0, 300), RETRY_MINUTES]);
    }
  }
  return rows.length;
}

module.exports = { AGENTS, catalog, list, update, isOn, everyHours, tick, runOne, raise, parseTokens, scheduleText, AgentsRefused, TOKEN_WATCH_MAX, LAUNCH_SAFETY_MAX, TOKEN_LISTS, RUNNERS };

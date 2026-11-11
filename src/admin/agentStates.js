/**
 * Each AI agent's state, set in the admin panel:
 *   active  listed and working (the default);
 *   hidden  works for anyone already using it and by its direct link, but
 *           isn't listed, offered or in the sitemap (its page is noindex);
 *   off     paused: new runs are refused with a plain message, schedules
 *           stop, and accounts that had it on get one alert when it's switched off.
 * It never deletes anyone's settings: switched back on, an agent carries on.
 */
const db = require('../config/db');
const settings = require('./settings');

const STATES = ['active', 'hidden', 'off'];
/** Agents that aren't in services/myAgents.js: a project's Telegram bots and the on-request audit. */
const OTHERS = [
  { id: 'group_guard', name: 'Group Guard' },
  { id: 'channel_poster', name: 'Channel Poster' },
  { id: 'contract_audit', name: 'Contract Audit' },
];

class AgentPaused extends Error {
  constructor(name) { super(`${name} is paused by RektBull for now. Nothing was charged; please try again later.`); this.status = 503; this.code = 'agent_paused'; }
}

const all = () => [...require('../services/myAgents').AGENTS.map(a => ({ id: a.id, name: a.name })), ...OTHERS];
const known = id => all().some(a => a.id === id);
const state = id => settings.get(`agent:${id}`)?.state || 'active';
const listed = id => state(id) === 'active';
const isOff = id => state(id) === 'off';

/** Throws AgentPaused when the agent is off (read from the database, not the minute-old copy). */
async function refuseIfOff(id) {
  const v = await settings.read(`agent:${id}`);
  if (v?.state === 'off') throw new AgentPaused(all().find(a => a.id === id)?.name || id);
}

/** The accounts using an agent: an explicit "on", or (for agents on by default) what makes them run. */
async function usersOf(id) {
  const a = require('../services/myAgents').AGENTS.find(x => x.id === id);
  const queries = [];
  if (a) queries.push(['SELECT account_id FROM agent_settings WHERE agent = $1 AND enabled', [id]]);
  if (a?.default_on && a.wallets === 'watched') {
    queries.push([`SELECT DISTINCT account_id FROM monitored_wallets WHERE account_id NOT IN (SELECT account_id FROM agent_settings WHERE agent = $1 AND NOT enabled)`, [id]]);
  }
  if (id === 'trading_agent') queries.push([`SELECT DISTINCT account_id FROM trade_permissions WHERE status = 'active'`, []]);
  const ids = new Set();
  for (const [q, params] of queries) {
    try { (await db.query(q, params)).rows.forEach(r => ids.add(Number(r.account_id))); } catch { /* a table this agent doesn't have here */ }
  }
  return [...ids];
}

/** Sets an agent's state, logged; switching one off tells the accounts that used it, once. */
async function setState(id, next, { wallet, reason }) {
  if (!known(id)) throw Object.assign(new Error('No such agent.'), { status: 404 });
  if (!STATES.includes(next)) throw Object.assign(new Error(`state must be one of: ${STATES.join(', ')}.`), { status: 400 });
  const before = state(id);
  await settings.set(`agent:${id}`, next === 'active' ? null : { state: next }, { wallet, action: 'agent_state', reason });
  let told = 0;
  if (next === 'off' && before !== 'off') {
    const name = all().find(a => a.id === id).name;
    const { raise } = require('../services/myAgents');
    const stamp = new Date().toISOString().slice(0, 16);
    told += await tellTelegram(id, name);
    for (const accountId of await usersOf(id)) {
      const { rows } = await db.query('SELECT wallet FROM accounts WHERE id = $1', [accountId]);
      if (!rows.length) continue;
      told += await raise(accountId, [{
        wallet: rows[0].wallet, kind: 'agent_paused', severity: 'medium', dedupe: `agent_paused:${id}:${stamp}`,
        title: `${name} is paused for now`,
        detail: { agent: id, reasons: [{ text: `RektBull has paused ${name}. It won't run or send alerts until it's back on; your settings are kept. Nothing is charged while it's paused.`, source: 'RektBull' }] },
      }]);
    }
  }
  return { id, state: next, before, told };
}

/** The Telegram agents' users aren't wallets: one message to each group, and to each channel's owner in private. */
async function tellTelegram(id, name) {
  const text = `${name} is paused by RektBull for now. It won't act or post until it's back on; your settings are kept.`;
  const q = id === 'group_guard' ? 'SELECT chat_id AS to FROM guard_groups WHERE enabled AND removed_at IS NULL'
    : id === 'channel_poster' ? 'SELECT DISTINCT owner_user_id AS to FROM poster_channels WHERE enabled AND removed_at IS NULL' : null;
  if (!q) return 0;
  const tg = require('../providers/telegramBot');
  let n = 0;
  for (const r of (await db.query(q)).rows) {
    try { await tg.send(r.to, text); n += 1; } catch { /* the bot was removed or blocked there */ }
  }
  return n;
}

function adminList() {
  return all().map(a => ({ ...a, state: state(a.id) }));
}

/**
 * Pages: drops <!--agent:ID-->…<!--/agent:ID--> blocks for agents that aren't
 * listed, and writes <!--#agent-links--> from the agents that are.
 */
function stripPage(html) {
  if (!html.includes('<!--agent:') && !html.includes('<!--#agent-links-->')) return html;
  let out = html.replace(/<!--agent:([a-z_]+)-->([\s\S]*?)<!--\/agent:\1-->/g, (_, id, inner) => (listed(id) ? inner : ''));
  if (out.includes('<!--#agent-links-->')) {
    const ap = require('../pages/agentPage');
    const links = ap.list().map(a => `<a href="/agents/${a.slug}">${a.name}</a>`);
    out = out.replace('<!--#agent-links-->', links.join(' · '));
  }
  return out;
}

module.exports = { STATES, OTHERS, AgentPaused, all, state, listed, isOff, refuseIfOff, setState, adminList, usersOf, stripPage };

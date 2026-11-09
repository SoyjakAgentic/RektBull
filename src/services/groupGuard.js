/**
 * Group Guard: RektBull's Telegram bot, added to a crypto project's group as
 * an admin, checks what's posted there.
 *
 *   - Links: each one against GoPlus's phishing site list. A known phishing
 *     link is deleted (when the bot may delete) with a warning that names
 *     the source. A link that looks like one of the group's official sites
 *     but isn't gets a warning.
 *   - Contract addresses: one that isn't the group's official contract, posted
 *     with words like "contract" or "CA", gets a warning with the official
 *     one. On the chains the group set, a token GoPlus reports as a honeypot
 *     (or one whose holders can't sell, or whose owner can change balances)
 *     gets a warning.
 *   - Impersonators: a member whose name copies an admin's, or who calls
 *     themselves support or admin without being one, is flagged once a day.
 *   - /check <chain> <address> for anyone; /guard and the settings commands
 *     for the group's admins only.
 *
 * Admins' own messages are never checked. Nothing is decided by AI. No
 * message text and no sender is stored: only the group's settings and daily
 * counts. Replies are capped per group per day, so the bot can't be made to
 * flood a group.
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const tg = require('../providers/telegramBot');
const { cached } = require('../lib/cache');
const { EVM } = require('../providers/chains');

const LIMITS = { replies: 200, links_checked: 600, tokens_checked: 150 };
const ADMINS_TTL_MS = 10 * 60 * 1000;
const FOOTER = 'Checked by RektBull · rektbull.com';
const CHAINS = [...Object.keys(EVM), 'solana'];
const EVM_RE = /\b0x[0-9a-fA-F]{40}\b/g;
const SOL_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const URL_RE = /\b((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?::\d+)?(?:\/[^\s]*)?/gi;
// Plain-text domains count as links only with a scheme, a www., or a common top-level domain (so "e.g." or "token.address" aren't links).
const TLDS = new Set('com net org io xyz app fi finance co me gg dev site online top live info cc pro ai so to ly vip club fun link click claims claim gift exchange network wallet money cash bet win shop store ru cn us uk de eu'.split(' '));
const CONTRACT_WORDS = /\b(ca|contract|address|token|buy|official|addy)\b/i;
const ROLE_WORDS = /(support|admin|helpdesk|moderator|\bmod\b|official|team)/i;

/* ── text helpers ── */

const CONFUSABLE = { 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '|': 'l', 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'һ': 'h', 'ԁ': 'd' };
/** A name reduced to what it looks like: lower case, look-alike characters mapped, accents and symbols dropped. */
function looks(name) {
  return String(name || '').replace(/I/g, 'l').toLowerCase().normalize('NFKD') // a capital I passes for a lower-case l.replace(/[̀-ͯ]/g, '')
    .split('').map(c => CONFUSABLE[c] ?? c).join('')
    .replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[^a-z0-9]/g, '');
}

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const nameOf = u => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.username || 'someone';

/** Does this user's name copy an admin's, or claim a role they don't have? The admin copied, or the word claimed. */
function impersonates(user, admins) {
  const mine = [looks(nameOf(user)), looks(user.username)].filter(s => s.length >= 3);
  for (const a of admins) {
    if (a.user.id === user.id || a.user.is_bot) continue;
    const theirs = [looks(nameOf(a.user)), looks(a.user.username)].filter(s => s.length >= 4);
    for (const m of mine) for (const t of theirs) {
      if (m === t || (t.length >= 5 && distance(m, t) <= 1) || (m.includes(t) && ROLE_WORDS.test(`${nameOf(user)} ${user.username || ''}`))) return { copies: nameOf(a.user) };
    }
  }
  const claim = `${nameOf(user)} ${user.username || ''}`.match(ROLE_WORDS);
  return claim ? { claims: claim[1].toLowerCase() } : null;
}

const hostOf = raw => {
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
};
const rootOf = host => host.split('.').slice(-2).join('.');

/** Hosts linked in a message: Telegram's url and text_link entities, and anything that looks like a domain. */
function linksIn(msg) {
  const text = msg.text || msg.caption || '';
  const hosts = new Set();
  for (const e of [...(msg.entities || []), ...(msg.caption_entities || [])]) {
    if (e.type === 'text_link' && e.url) hosts.add(hostOf(e.url));
    if (e.type === 'url') hosts.add(hostOf(text.slice(e.offset, e.offset + e.length)));
  }
  for (const m of text.matchAll(URL_RE)) {
    const explicit = /^(https?:\/\/|www\.)/i.test(m[0]);
    if (explicit || TLDS.has(m[1].split('.').pop().toLowerCase())) hosts.add(hostOf(m[0]));
  }
  hosts.delete(null);
  return [...hosts].filter(h => !/^(t\.me|telegram\.me|telegram\.org)$/.test(h));
}

/** A host that looks like an official site without being it (same name, another domain; or one character off). */
function lookalike(host, official) {
  for (const o of official) {
    if (host === o || host.endsWith(`.${o}`)) return null;
    const [hn, on] = [looks(rootOf(host).split('.')[0]), looks(rootOf(o).split('.')[0])];
    if (on.length >= 4 && (hn === on || (on.length >= 5 && distance(hn, on) <= 1) || looks(host).includes(on))) return o;
  }
  return null;
}

/* ── storage ── */

async function group(chatId) {
  const { rows } = await db.query('SELECT * FROM guard_groups WHERE chat_id = $1', [String(chatId)]);
  return rows[0] || null;
}

async function count(chatId, kind, n = 1) {
  const { rows } = await db.query(
    `INSERT INTO guard_counts (chat_id, kind, n) VALUES ($1, $2, $3)
     ON CONFLICT (chat_id, day, kind) DO UPDATE SET n = guard_counts.n + $3 RETURNING n`,
    [String(chatId), kind, n],
  );
  return rows[0].n;
}

/** Takes one of today's uses of kind for the group; false once the day's limit is reached. */
async function take(chatId, kind) {
  return (await count(chatId, kind)) <= LIMITS[kind];
}

async function saveSettings(chatId, settings) {
  await db.query('UPDATE guard_groups SET settings = $2, updated_at = now() WHERE chat_id = $1', [String(chatId), JSON.stringify(settings)]);
}

/* ── Telegram ── */

const adminCache = new Map();
async function admins(chatId) {
  const hit = adminCache.get(chatId);
  if (hit && hit.at > Date.now() - ADMINS_TTL_MS) return hit.list;
  const list = await tg.admins(chatId);
  adminCache.set(chatId, { at: Date.now(), list });
  return list;
}
const isAdmin = async (chatId, userId) => (await admins(chatId)).some(a => a.user.id === userId);

async function say(chatId, replyTo, text) {
  if (!(await take(chatId, 'replies'))) return false;
  await tg.reply(chatId, replyTo, `${text}\n\n${FOOTER}`).catch(err => logger.warn('group guard: reply failed', { error: err.message }));
  return true;
}

/* ── checks ── */

const goplusToken = (chain, token) => cached(`guard:goplus:${chain}:${token}`, 6 * 3600, () => require('./tokenRisk').goplus(chain, token));

function tokenWarnings(g) {
  if (!g || g.not_checked) return [];
  return [
    g.honeypot && 'GoPlus reports it as a honeypot: it can be bought but not sold',
    g.cannot_sell_all && 'holders can\'t sell their whole balance',
    g.owner_change_balance && 'its owner can change holders\' balances',
    (g.sell_tax_pct ?? 0) > 30 && `it taxes sales ${g.sell_tax_pct}%`,
  ].filter(Boolean);
}

async function checkLinks(msg, g) {
  const official = g.settings.official_sites || [];
  for (const host of linksIn(msg)) {
    if (official.some(o => host === o || host.endsWith(`.${o}`))) continue;
    if (!(await take(msg.chat.id, 'links_checked'))) return;
    let phishing = false;
    try { phishing = (await require('../providers/goplus').phishingSite(`https://${host}`)).phishing; } catch (err) { logger.warn('group guard: phishing check failed', { error: err.message }); }
    if (phishing) {
      const deleted = await tg.deleteMessage(msg.chat.id, msg.message_id).then(() => true, () => false);
      await count(msg.chat.id, 'phishing_removed');
      await say(msg.chat.id, deleted ? null : msg.message_id, `⚠️ ${deleted ? 'Removed a message with' : 'This message has'} a link to ${host}, which GoPlus lists as a phishing site (source: GoPlus phishing site list). Don't open it or connect a wallet to it.${deleted ? '' : ' Admins: give me the "Delete messages" right and I\'ll remove these.'}`);
      return;
    }
    const like = lookalike(host, official);
    if (like) {
      await count(msg.chat.id, 'lookalike_warned');
      await say(msg.chat.id, msg.message_id, `⚠️ ${host} looks like ${like}, this group's official site, but isn't it. Fake copies of project sites are how wallets get drained: use ${like}, typed in yourself.`);
      return;
    }
  }
}

async function checkAddresses(msg, g) {
  const text = msg.text || msg.caption || '';
  const official = g.settings.official_contracts || [];
  const evm = [...new Set((text.match(EVM_RE) || []).map(a => a.toLowerCase()))];
  const sol = official.some(o => o.chain === 'solana') || (g.settings.chains || []).includes('solana') ? [...new Set((text.match(SOL_RE) || []).filter(a => !/^0x/.test(a)))] : [];
  for (const addr of [...evm, ...sol]) {
    const isOfficial = official.some(o => (o.chain === 'solana' ? o.address === addr : o.address === addr.toLowerCase()));
    if (isOfficial) continue;
    if (official.length && CONTRACT_WORDS.test(text)) {
      await count(msg.chat.id, 'contract_warned');
      await say(msg.chat.id, msg.message_id, `⚠️ This isn't the official contract. The official one${official.length > 1 ? 's' : ''}, set by the group's admins: ${official.map(o => `${o.address} (${o.chain})`).join(', ')}. Scammers post fake contract addresses in project groups: check before you buy.`);
      return;
    }
    if (!addr.startsWith('0x')) continue;
    for (const chain of (g.settings.chains || []).filter(c => EVM[c])) {
      if (!(await take(msg.chat.id, 'tokens_checked'))) return;
      const warnings = tokenWarnings(await goplusToken(chain, addr));
      if (warnings.length) {
        await count(msg.chat.id, 'token_warned');
        await say(msg.chat.id, msg.message_id, `⚠️ The token ${addr} on ${chain}: ${warnings.join('; ')} (source: GoPlus). Full check: https://rektbull.com/safety?chain=${chain}&token=${addr}`);
        return;
      }
    }
  }
}

const flagged = new Map(); // `${chat}:${user}` -> day, so a member is flagged once a day
async function checkMember(chatId, user, replyTo) {
  if (!user || user.is_bot) return;
  const key = `${chatId}:${user.id}`;
  const today = new Date().toISOString().slice(0, 10);
  if (flagged.get(key) === today) return;
  const list = await admins(chatId);
  if (list.some(a => a.user.id === user.id)) return;
  const hit = impersonates(user, list);
  if (!hit) return;
  flagged.set(key, today);
  await count(chatId, 'impersonator_flagged');
  const who = user.username ? `@${user.username}` : `"${nameOf(user)}"`;
  await say(chatId, replyTo, `⚠️ ${who} isn't an admin of this group, ${hit.copies ? `but their name looks like admin ${hit.copies}'s` : `but their name says "${hit.claims}"`}. Admins and support never DM you first. Anyone who does, and asks you to "verify" or "validate" a wallet, is a scammer.`);
}

/* ── commands ── */

const HELP = [
  'RektBull Group Guard checks links and contract addresses posted here, and flags members whose names copy an admin\'s.',
  'Anyone: /check <chain> <address> to check a token.',
  'Admins:',
  '/guard to see the settings',
  '/official_site example.com (add or remove with /official_site -example.com)',
  '/official_contract <chain> <address> (remove with /official_contract -<address>)',
  '/guard_chains base,ethereum to check posted tokens on those chains',
  '/guard_off and /guard_on',
  'For links to be removed, make me an admin with the "Delete messages" right. I never DM anyone first.',
].join('\n');

function describe(g) {
  const s = g.settings;
  return [
    `Group Guard is ${g.enabled ? 'on' : 'off'} here.`,
    `Official sites: ${(s.official_sites || []).join(', ') || 'none set'}.`,
    `Official contracts: ${(s.official_contracts || []).map(o => `${o.address} (${o.chain})`).join(', ') || 'none set'}.`,
    `Posted tokens checked on: ${(s.chains || []).join(', ') || 'no chain set'}.`,
  ].join('\n');
}

async function command(msg, g) {
  const [cmdRaw, ...args] = (msg.text || '').trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@\w+$/, '');
  const chatId = msg.chat.id;
  if (cmd === '/check') {
    const [chain, addr] = [String(args[0] || '').toLowerCase(), args[1]];
    if (!EVM[chain] || !/^0x[0-9a-fA-F]{40}$/.test(addr || '')) return say(chatId, msg.message_id, `Use /check <chain> <address>, with a chain from: ${Object.keys(EVM).join(', ')}. For Solana tokens: https://rektbull.com/safety`);
    if (!(await take(chatId, 'tokens_checked'))) return null;
    const r = await goplusToken(chain, addr.toLowerCase());
    if (r.not_checked) return say(chatId, msg.message_id, `Couldn't check it just now: ${r.not_checked}.`);
    const w = tokenWarnings(r);
    return say(chatId, msg.message_id, `${addr} on ${chain}: ${w.length ? `⚠️ ${w.join('; ')}` : 'no honeypot, sell-limit or balance-changing flags'} (source: GoPlus).${r.buy_tax_pct !== null || r.sell_tax_pct !== null ? ` Taxes: ${r.buy_tax_pct ?? '?'}% to buy, ${r.sell_tax_pct ?? '?'}% to sell.` : ''} A clean result isn't proof of safety. Full check: https://rektbull.com/safety?chain=${chain}&token=${addr}`);
  }
  if (cmd === '/help' || cmd === '/start') return say(chatId, msg.message_id, HELP);
  const settingsCmds = ['/guard', '/official_site', '/official_contract', '/guard_chains', '/guard_off', '/guard_on'];
  if (!settingsCmds.includes(cmd)) return null;
  if (!(await isAdmin(chatId, msg.from?.id))) return say(chatId, msg.message_id, 'Only this group\'s admins can change Group Guard\'s settings.');
  const s = { ...g.settings };
  if (cmd === '/official_site') {
    const raw = String(args[0] || '');
    const remove = raw.startsWith('-');
    const host = hostOf(raw.replace(/^-/, ''));
    if (!host || !/\.[a-z]{2,24}$/.test(host)) return say(chatId, msg.message_id, 'Use /official_site example.com');
    s.official_sites = remove ? (s.official_sites || []).filter(h => h !== host) : [...new Set([...(s.official_sites || []), host])].slice(0, 10);
  } else if (cmd === '/official_contract') {
    if (String(args[0] || '').startsWith('-')) {
      const addr = args[0].slice(1);
      s.official_contracts = (s.official_contracts || []).filter(o => o.address !== addr && o.address !== addr.toLowerCase());
    } else {
      const chain = String(args[0] || '').toLowerCase();
      const addr = args[1] || '';
      const ok = chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) : EVM[chain] && /^0x[0-9a-fA-F]{40}$/.test(addr);
      if (!ok) return say(chatId, msg.message_id, `Use /official_contract <chain> <address>, with a chain from: ${CHAINS.join(', ')}.`);
      s.official_contracts = [...(s.official_contracts || []).filter(o => o.address !== addr), { chain, address: chain === 'solana' ? addr : addr.toLowerCase() }].slice(0, 5);
      s.chains = [...new Set([...(s.chains || []), chain])];
    }
  } else if (cmd === '/guard_chains') {
    const list = String(args.join(',')).toLowerCase().split(/[\s,]+/).filter(Boolean);
    const bad = list.filter(c => !CHAINS.includes(c));
    if (bad.length) return say(chatId, msg.message_id, `Unknown chain: ${bad.join(', ')}. Choose from: ${CHAINS.join(', ')}.`);
    s.chains = list;
  } else if (cmd === '/guard_off' || cmd === '/guard_on') {
    await db.query('UPDATE guard_groups SET enabled = $2, updated_at = now() WHERE chat_id = $1', [String(chatId), cmd === '/guard_on']);
    return say(chatId, msg.message_id, cmd === '/guard_on' ? 'Group Guard is on.' : 'Group Guard is off. /guard_on to switch it back on.');
  }
  if (cmd !== '/guard') await saveSettings(chatId, s);
  return say(chatId, msg.message_id, describe({ ...g, settings: s }));
}

/* ── the webhook ── */

async function joined(chat, by) {
  await db.query(
    `INSERT INTO guard_groups (chat_id, title, added_at) VALUES ($1, $2, now())
     ON CONFLICT (chat_id) DO UPDATE SET title = EXCLUDED.title, removed_at = NULL, updated_at = now()`,
    [String(chat.id), String(chat.title || '').slice(0, 120)],
  );
  logger.info('group guard: added to a group', { chat: chat.id, by: by?.id });
  await say(chat.id, null, `RektBull Group Guard is here. I check links and contract addresses posted in this group, remove known phishing links, and flag members whose names copy an admin's.\n\nAdmins: make me an admin with "Delete messages", then set the official site and contract:\n/official_site example.com\n/official_contract base 0x…\n/guard shows the settings. I never DM anyone first.`);
}

/** One update from Telegram for a group: the bot added or removed, a member joining, or a message. */
async function handle(update) {
  // Switched off in the admin panel: nothing is checked or removed; a command gets one plain answer.
  if (require('../admin/agentStates').isOff('group_guard')) {
    const m = update.message;
    if (m && /^\/guard/i.test(m.text || '')) await say(m.chat.id, m.message_id, 'Group Guard is paused by RektBull for now. Your settings are kept.');
    return { ok: true, group: true, paused: true };
  }
  const change = update.my_chat_member;
  if (change && ['group', 'supergroup'].includes(change.chat.type)) {
    const now = change.new_chat_member?.status;
    if (['member', 'administrator'].includes(now) && !['member', 'administrator'].includes(change.old_chat_member?.status)) await joined(change.chat, change.from);
    if (['left', 'kicked'].includes(now)) await db.query('UPDATE guard_groups SET removed_at = now() WHERE chat_id = $1', [String(change.chat.id)]);
    adminCache.delete(change.chat.id);
    return { ok: true, group: true };
  }
  const memberUpdate = update.chat_member;
  if (memberUpdate && ['member', 'restricted'].includes(memberUpdate.new_chat_member?.status) && ['left', 'kicked'].includes(memberUpdate.old_chat_member?.status)) {
    const g = await group(memberUpdate.chat.id);
    if (g && g.enabled && !g.removed_at) await checkMember(memberUpdate.chat.id, memberUpdate.new_chat_member.user, null);
    return { ok: true, group: true };
  }
  const msg = update.message || update.edited_message;
  if (!msg || !['group', 'supergroup'].includes(msg.chat?.type)) return { ok: true };
  let g = await group(msg.chat.id);
  if (!g) { await joined(msg.chat, msg.from); g = await group(msg.chat.id); }
  if (g.removed_at) return { ok: true, group: true };
  if (/^\//.test(msg.text || '')) { await command(msg, g); return { ok: true, group: true }; }
  if (!g.enabled) return { ok: true, group: true };
  for (const u of msg.new_chat_members || []) await checkMember(msg.chat.id, u, msg.message_id);
  if (msg.from && !msg.new_chat_members && !msg.sender_chat) {
    if (await isAdmin(msg.chat.id, msg.from.id)) return { ok: true, group: true };
    await checkMember(msg.chat.id, msg.from, msg.message_id);
    await checkLinks(msg, g);
    await checkAddresses(msg, g);
  }
  return { ok: true, group: true };
}

/** What Group Guard has done, in aggregate (for the page and the owner): groups and the last 30 days' counts. */
async function stats() {
  const { rows: [g] } = await db.query('SELECT count(*) FILTER (WHERE removed_at IS NULL)::int AS groups FROM guard_groups');
  const { rows } = await db.query(`SELECT kind, sum(n)::int AS n FROM guard_counts WHERE day > CURRENT_DATE - 30 GROUP BY kind`);
  return { groups: g.groups, last_30_days: Object.fromEntries(rows.map(r => [r.kind, r.n])) };
}

const addLink = () => (env.telegramBotUsername ? `https://t.me/${env.telegramBotUsername}?startgroup=guard&admin=delete_messages` : null);

module.exports = { handle, stats, addLink, looks, impersonates, lookalike, linksIn, tokenWarnings, LIMITS, HELP, _adminCache: adminCache, _flagged: flagged };

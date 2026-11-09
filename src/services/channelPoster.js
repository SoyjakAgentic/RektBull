/**
 * Channel Poster: drafts posts for a crypto project's Telegram channel from
 * RektBull's own data, and posts each one only when an admin of the channel
 * approves it.
 *
 *   Setup: the project adds RektBull's bot to its channel as an admin with
 *   "Post messages". The admin who added it gets the drafts, in a private
 *   chat with the bot (Telegram lets a bot message only people who started
 *   it, so they /start it first). /poster there sets what to draft.
 *
 *   Topics, each from a sourced RektBull feed:
 *     hacks      large hacks on the channel's chains (DefiLlama's hack record)
 *     votes      new votes, and votes closing within a day, in its Snapshot space
 *     campaigns  new Merkl reward campaigns on its protocol (facts, never a rate)
 *
 *   Each draft goes to the owner with Post and Skip buttons; nothing reaches
 *   the channel without that tap, from someone who is still an admin of it.
 *   Each item is drafted once; a draft left 3 days expires. On a topic's
 *   first run, what's already live is recorded, not drafted, so a new channel
 *   isn't flooded with old news.
 */
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const tg = require('../providers/telegramBot');

const TOPICS = { hacks: 'Large hacks on your chains', votes: 'Votes in your Snapshot space', campaigns: 'Reward campaigns on your protocol' };
const CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc', 'solana'];
const LLAMA_CHAIN = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bsc: 'BSC', solana: 'Solana' };
const HACK_MIN_USD = 1e6;
const HACK_DAYS = 3;
const PER_TICK = 10;
const EXPIRE_DAYS = 3;
const FOOTER = 'Drafted with RektBull · rektbull.com';

const usd = v => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`);
const day = iso => new Date(iso).toISOString().slice(0, 16).replace('T', ' ');

/* ── storage ── */

async function channelsOf(userId) {
  const { rows } = await db.query('SELECT * FROM poster_channels WHERE owner_user_id = $1 AND removed_at IS NULL ORDER BY added_at', [String(userId)]);
  return rows;
}

async function saveSettings(chatId, settings) {
  await db.query('UPDATE poster_channels SET settings = $2 WHERE chat_id = $1', [chatId, JSON.stringify(settings)]);
}

/** Is this user an admin of the channel now (Telegram's own answer)? */
async function canManage(chatId, userId) {
  try {
    const m = await tg.member(chatId, userId);
    return ['creator', 'administrator'].includes(m?.status);
  } catch { return false; }
}

/* ── what to draft ── */

/** The items each topic would draft for a channel now: [{ key, text }]. */
const SOURCES = {
  async hacks(s) {
    const list = await require('../providers/llama').hackList();
    const since = new Date(Date.now() - HACK_DAYS * 86400000).toISOString().slice(0, 10);
    const chains = (s.chains || []).map(c => LLAMA_CHAIN[c]);
    return list
      .filter(h => h.date >= since && (h.amount_usd || 0) >= (s.hack_min_usd || HACK_MIN_USD) && (!chains.length || h.chains.some(c => chains.includes(c))))
      .map(h => ({
        key: `hack:${h.date}:${h.name}`,
        text: `⚠️ ${h.name} was hacked on ${h.date}${h.chains.length ? ` (${h.chains.join(', ')})` : ''}: ${usd(h.amount_usd)} lost${h.technique ? `, by ${h.technique.toLowerCase()}` : ''}.${h.returned_usd ? ` ${usd(h.returned_usd)} has been returned.` : ''}\n\nIf you used it, check what your wallet has approved and revoke what you don't need: https://rektbull.com\n\nSource: DefiLlama's hack record${h.source ? `, ${h.source}` : ''}`,
      }));
  },
  async votes(s) {
    if (!s.snapshot_space) return [];
    const snapshot = require('../providers/snapshot');
    const props = await snapshot.activeProposals([s.snapshot_space]);
    const now = Date.now() / 1000;
    const link = p => `https://snapshot.box/#/s:${s.snapshot_space}/proposal/${p.id}`;
    return props.flatMap(p => [
      { key: `vote:${p.id}`, text: `🗳 New vote: ${p.title}\n\nVoting ends ${day(p.end * 1000)} UTC. Read the proposal and vote from your own wallet: ${link(p)}\n\nSource: Snapshot` },
      ...(p.end - now <= 86400 ? [{ key: `vote-closing:${p.id}`, text: `⏳ Voting closes in under a day: ${p.title}\n\nEnds ${day(p.end * 1000)} UTC: ${link(p)}\n\nSource: Snapshot` }] : []),
    ]);
  },
  async campaigns(s) {
    if (!s.protocol_slug) return [];
    const merkl = require('../providers/merkl');
    const chains = (s.chains || []).filter(c => c !== 'solana');
    const lists = await Promise.allSettled((chains.length ? chains : ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc']).map(c => merkl.live(c)));
    return lists.flatMap(r => (r.status === 'fulfilled' ? r.value : []))
      .filter(c => c.protocol?.defillama_slug === s.protocol_slug)
      .map(c => ({
        key: `campaign:${c.id}`,
        text: `A Merkl reward campaign is live on ${c.protocol.name} (${c.chain}): ${c.name}.\n\nWhat taking part involves, and the protocol's record: https://rektbull.com/opportunities\n\nSource: Merkl. Not advice; rewards change and are never guaranteed.`,
      }));
  },
};

/** Drafts what's new for one channel. Returns how many drafts were added. */
async function draft(ch) {
  const s = ch.settings || {};
  const baselined = new Set(s.baselined || []);
  let added = 0;
  for (const topic of s.topics || []) {
    let items;
    try { items = await SOURCES[topic](s); } catch (err) { logger.warn('channel poster: source failed', { topic, error: err.message }); continue; }
    // On a topic's first run, what's already there is recorded, not drafted (votes still open are worth drafting).
    const status = baselined.has(topic) || topic === 'votes' ? 'pending' : 'baseline';
    for (const it of items) {
      const { rowCount } = await db.query(
        `INSERT INTO poster_drafts (chat_id, key, topic, text, status) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (chat_id, key) DO NOTHING`,
        [ch.chat_id, it.key, topic, it.text.slice(0, 3500), status],
      );
      if (rowCount && status === 'pending') added++;
    }
    if (!baselined.has(topic)) { baselined.add(topic); s.baselined = [...baselined]; await saveSettings(ch.chat_id, s); }
  }
  return added;
}

/** Sends pending drafts to the channel's owner, with Post and Skip buttons. */
async function offer(ch) {
  const { rows } = await db.query(`SELECT * FROM poster_drafts WHERE chat_id = $1 AND status = 'pending' AND sent_at IS NULL ORDER BY created_at LIMIT $2`, [ch.chat_id, PER_TICK]);
  for (const d of rows) {
    try {
      await tg.buttons(ch.owner_user_id, `Draft for ${ch.title || 'your channel'} (${TOPICS[d.topic].toLowerCase()}):\n\n${d.text}\n\n${FOOTER}`, [{ text: 'Post to the channel', data: `cp:post:${d.id}` }, { text: 'Skip', data: `cp:skip:${d.id}` }]);
      await db.query('UPDATE poster_drafts SET sent_at = now() WHERE id = $1', [d.id]);
    } catch (err) {
      logger.warn('channel poster: could not send a draft to its owner', { error: err.message });
      break; // they haven't started the bot, or blocked it: try again next time
    }
  }
  return rows.length;
}

/** The worker's job: expire old drafts, draft what's new, send drafts for approval. */
async function tick() {
  if (require('../admin/agentStates').isOff('channel_poster')) return { paused: true };
  await db.query(`UPDATE poster_drafts SET status = 'expired' WHERE status = 'pending' AND created_at < now() - make_interval(days => $1)`, [EXPIRE_DAYS]);
  const { rows } = await db.query(`SELECT * FROM poster_channels WHERE enabled AND removed_at IS NULL`);
  let drafted = 0;
  for (const ch of rows) {
    try { drafted += await draft(ch); await offer(ch); } catch (err) { logger.warn('channel poster: channel failed', { chat: ch.chat_id, error: err.message }); }
  }
  return drafted;
}

/* ── Telegram updates ── */

const HELP = [
  'Channel Poster drafts posts for your Telegram channel from RektBull\'s data, and posts each one only when you tap Post.',
  'Set up: add me to your channel as an admin with "Post messages". Then, here:',
  '/poster to see your channels and their settings',
  `/poster_topics 1 hacks,votes,campaigns (any of: ${Object.keys(TOPICS).join(', ')})`,
  `/poster_chains 1 base,ethereum (for hacks and campaigns; any of: ${CHAINS.join(', ')})`,
  '/poster_space 1 yourdao.eth (your Snapshot space, for votes)',
  '/poster_protocol 1 your-protocol (its DefiLlama name, for campaigns)',
  '/poster_off 1 and /poster_on 1',
  'The number is the channel\'s number in /poster.',
].join('\n');

function describe(list) {
  if (!list.length) return `You have no channels yet.\n\n${HELP}`;
  return list.map((c, i) => {
    const s = c.settings || {};
    return `${i + 1}. ${c.title || c.chat_id} (${c.enabled ? 'on' : 'off'})\n   Topics: ${(s.topics || []).join(', ') || 'none yet'}\n   Chains: ${(s.chains || []).join(', ') || 'all'}\n   Snapshot space: ${s.snapshot_space || 'not set'}\n   Protocol: ${s.protocol_slug || 'not set'}`;
  }).join('\n\n') + '\n\n/help for the commands.';
}

/** A private message starting with /poster (or /help in a chat that has channels). */
async function command(msg) {
  const userId = String(msg.from.id);
  const [cmdRaw, nRaw, ...rest] = (msg.text || '').trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@\w+$/, '');
  const reply = text => tg.send(msg.chat.id, text).catch(err => logger.warn('channel poster: reply failed', { error: err.message }));
  if (require('../admin/agentStates').isOff('channel_poster')) return reply('Channel Poster is paused by RektBull for now. Your channels and settings are kept.');
  const list = await channelsOf(userId);
  if (cmd === '/poster') return reply(describe(list));
  const ch = list[Number(nRaw) - 1];
  if (!ch) return reply(list.length ? `Use a channel number from /poster (1 to ${list.length}).` : describe(list));
  if (!(await canManage(ch.chat_id, msg.from.id))) return reply(`You're no longer an admin of ${ch.title || 'that channel'}, so its settings can't be changed from here.`);
  const s = { ...(ch.settings || {}) };
  const arg = rest.join(' ').trim();
  const items = arg.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (cmd === '/poster_topics') {
    const bad = items.filter(t => !TOPICS[t]);
    if (!items.length || bad.length) return reply(`Topics are: ${Object.keys(TOPICS).join(', ')}.`);
    s.topics = [...new Set(items)];
  } else if (cmd === '/poster_chains') {
    const bad = items.filter(c => !CHAINS.includes(c));
    if (bad.length) return reply(`Chains are: ${CHAINS.join(', ')}.`);
    s.chains = items;
  } else if (cmd === '/poster_space') {
    if (!/^[a-z0-9.-]{3,64}$/i.test(arg)) return reply('Use /poster_space 1 yourdao.eth');
    s.snapshot_space = arg.toLowerCase();
  } else if (cmd === '/poster_protocol') {
    if (!/^[a-z0-9-]{2,80}$/.test(arg.toLowerCase())) return reply('Use /poster_protocol 1 your-protocol (as on defillama.com/protocol/your-protocol)');
    s.protocol_slug = arg.toLowerCase();
  } else if (cmd === '/poster_off' || cmd === '/poster_on') {
    await db.query('UPDATE poster_channels SET enabled = $2 WHERE chat_id = $1', [ch.chat_id, cmd === '/poster_on']);
    return reply(`Channel Poster is ${cmd === '/poster_on' ? 'on' : 'off'} for ${ch.title || 'that channel'}.`);
  } else {
    return reply(HELP);
  }
  await saveSettings(ch.chat_id, s);
  return reply(describe(await channelsOf(userId)));
}

/** The bot added to, or removed from, a channel. */
async function membership(change) {
  const chat = change.chat;
  const now = change.new_chat_member?.status;
  if (['left', 'kicked'].includes(now) || (now === 'administrator' && change.new_chat_member.can_post_messages === false)) {
    if (['left', 'kicked'].includes(now)) await db.query('UPDATE poster_channels SET removed_at = now() WHERE chat_id = $1', [String(chat.id)]);
    return { ok: true, channel: true };
  }
  if (now !== 'administrator') return { ok: true, channel: true };
  await db.query(
    `INSERT INTO poster_channels (chat_id, title, owner_user_id) VALUES ($1, $2, $3)
     ON CONFLICT (chat_id) DO UPDATE SET title = EXCLUDED.title, removed_at = NULL`,
    [String(chat.id), String(chat.title || '').slice(0, 120), String(change.from.id)],
  );
  await tg.send(change.from.id, `Channel Poster is connected to ${chat.title || 'your channel'}. Choose what to draft:\n/poster_topics 1 hacks,votes,campaigns\n\n${HELP}`)
    .catch(() => logger.info('channel poster: the owner hasn\'t started the bot yet'));
  return { ok: true, channel: true };
}

/** A tap on Post or Skip. Only someone who is still an admin of the channel can decide. */
async function callback(q) {
  const m = /^cp:(post|skip):(\d+)$/.exec(q.data || '');
  if (!m) return { ok: true };
  const { rows: [d] } = await db.query('SELECT d.*, c.title, c.removed_at FROM poster_drafts d JOIN poster_channels c ON c.chat_id = d.chat_id WHERE d.id = $1', [Number(m[2])]);
  const answer = text => tg.answer(q.id, text).catch(() => {});
  if (require('../admin/agentStates').isOff('channel_poster')) return answer('Channel Poster is paused for now.');
  if (!d) return answer('That draft is gone.');
  if (d.status !== 'pending') return answer(`Already ${d.status}.`);
  if (d.removed_at) return answer('RektBull is no longer in that channel.');
  if (!(await canManage(d.chat_id, q.from.id))) return answer('Only an admin of the channel can do that.');
  if (m[1] === 'skip') {
    await db.query(`UPDATE poster_drafts SET status = 'skipped', decided_at = now(), decided_by = $2 WHERE id = $1 AND status = 'pending'`, [d.id, String(q.from.id)]);
    if (q.message) await tg.edit(q.message.chat.id, q.message.message_id, `Skipped:\n\n${d.text}`).catch(() => {});
    return answer('Skipped.');
  }
  // Claimed before posting, so a double tap can't post it twice.
  const { rowCount } = await db.query(`UPDATE poster_drafts SET status = 'posted', decided_at = now(), decided_by = $2 WHERE id = $1 AND status = 'pending'`, [d.id, String(q.from.id)]);
  if (!rowCount) return answer('Already decided.');
  try {
    await tg.send(d.chat_id, d.text);
  } catch (err) {
    await db.query(`UPDATE poster_drafts SET status = 'pending', decided_at = NULL, decided_by = NULL WHERE id = $1`, [d.id]);
    return answer(`Couldn't post it: ${err.message.replace(/^Telegram \w+: /, '')}. Check that I'm an admin who may post messages.`);
  }
  if (q.message) await tg.edit(q.message.chat.id, q.message.message_id, `Posted to ${d.title || 'the channel'} ✓\n\n${d.text}`).catch(() => {});
  return answer('Posted.');
}

const addLink = () => (env.telegramBotUsername ? `https://t.me/${env.telegramBotUsername}?startchannel=poster&admin=post_messages` : null);

module.exports = { tick, draft, offer, command, membership, callback, addLink, SOURCES, TOPICS, HELP };

/**
 * Hyperliquid perps from Telegram (docs/HYPERLIQUID.md, "From Telegram"): the
 * owner's call of 26 November 2026. A user whose Telegram chat is linked to
 * their RektBull account (for alerts), with automatic trading on and "Trade
 * from Telegram" switched on from the Perps page, can open and close
 * positions with commands:
 *
 *   /perps                     the grant, its limits, the positions
 *   /long BTC 100 3x sl 5 tp 10 a long of $100 at 3x, with a 5% stop and a 10% take-profit (both optional)
 *   /short ETH 50 2x            a short
 *   /close BTC                  closes the position
 *   /stopauto                   RektBull stops using its agent at once (no signature needed)
 *
 * Every open asks for a tap on Confirm (good for 60 seconds, used once). The
 * order goes through automatic trading (hyperliquid/auto.js): the same agent,
 * the same limits enforced by RektBull's trade service (not onchain), the
 * same checks before it's signed. The user decided it, so it carries their
 * own 0.01% (source 'user'). Telegram doesn't say where a user is, so the
 * place recorded on their last visit to the site is checked against the
 * region lists (compliance/regions.js), as for any automatic order.
 *
 * Nothing here can move money: RektBull's agent can trade and never withdraw.
 * Someone who got into the user's Telegram could trade within those limits,
 * which the Perps page says before the switch is turned on.
 */
const crypto = require('crypto');
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const services = require('../admin/services');
const regions = require('../compliance/regions');
const markets = require('../hyperliquid/markets');
const auto = require('../hyperliquid/auto');
const bot = require('../providers/telegramBot');

const CONFIRM_MS = 60 * 1000;
const COMMAND = /^\/(perps|long|short|close|stopauto)(?:@\w+)?(?:\s|$)/i;

class TgRefused extends Error {}
const no = m => { throw new TgRefused(m); };

const usd = n => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/* ── the switch, on the Perps page ── */

/** The chats linked to an account for alerts (verified, not turned off). */
async function chatsOf(accountId) {
  const { rows } = await db.query(`SELECT target FROM alert_channels WHERE account_id = $1 AND kind = 'telegram' AND verified_at IS NOT NULL AND disabled_at IS NULL`, [accountId]);
  return rows.map(r => r.target);
}

async function status(accountId) {
  const [{ rows: [t] }, chats] = await Promise.all([
    db.query('SELECT enabled, updated_at FROM telegram_trading WHERE account_id = $1', [accountId]),
    chatsOf(accountId),
  ]);
  return {
    linked: chats.length > 0, enabled: !!t?.enabled && chats.length > 0, updated_at: t?.updated_at || null,
    commands: ['/perps', '/long BTC 100 3x sl 5 tp 10', '/short ETH 50 2x', '/close BTC', '/stopauto'],
    risk: 'Anyone who gets into your Telegram account could open and close positions within your automatic-trading limits. They could never withdraw or transfer: RektBull\'s agent can\'t. Every open needs a tap on Confirm. Turn this off here, or send /stopauto, at any time.',
  };
}

/** Turns "Trade from Telegram" on or off (from the Perps page, signed in with the wallet). */
async function setEnabled(account, enabled) {
  if (enabled) {
    if (!(await chatsOf(account.id)).length) no('Link Telegram first (Connect Telegram on the AI agents page), then switch this on.');
    if (!(await auto.activeGrant(account.id))) no('Telegram commands trade through automatic trading: approve RektBull\'s agent, with your limits, first.');
  }
  await db.query(
    `INSERT INTO telegram_trading (account_id, enabled, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (account_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`, [account.id, !!enabled]);
  return status(account.id);
}

/* ── commands ── */

/** The account a private chat trades for: linked, with Telegram trading on. Exactly one. */
async function accountFor(chatId) {
  const { rows } = await db.query(
    `SELECT a.id, a.wallet FROM alert_channels c JOIN accounts a ON a.id = c.account_id JOIN telegram_trading t ON t.account_id = a.id AND t.enabled
     WHERE c.kind = 'telegram' AND c.target = $1 AND c.verified_at IS NOT NULL AND c.disabled_at IS NULL`, [String(chatId)]);
  if (!rows.length) no('Trading from Telegram is off for this chat. Switch on "Trade from Telegram" in the Automatic trading section of the Perps page on rektbull.com (this chat must be linked for alerts).');
  if (rows.length > 1) no('This chat is linked to more than one RektBull account with Telegram trading on. Leave it on for one only.');
  if (!rows[0].wallet) no('Hyperliquid accounts belong to EVM wallets: link one to your RektBull account first.');
  return rows[0];
}

/** "/long BTC 100 3x sl 5 tp 10" → { coin, side, size_usd, leverage, stop_loss_pct?, take_profit_pct? }. Coins as Hyperliquid names them. */
async function parseOpen(side, words) {
  const [coinIn, amount, ...rest] = words;
  if (!coinIn || !amount) no(`Usage: /${side} BTC 100 3x sl 5 tp 10 (the market, the size in USD, then the leverage, stop-loss and take-profit if you want them).`);
  const list = await markets.markets();
  const m = list.find(x => x.coin.toLowerCase() === coinIn.toLowerCase());
  if (!m) no(`There's no ${coinIn} market on Hyperliquid.`);
  const size = Number(String(amount).replace(/^\$/, '').replace(/,/g, ''));
  if (!(size > 0)) no('The size is in USD, such as 100.');
  const out = { coin: m.coin, side, size_usd: size, leverage: 1 };
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i].toLowerCase();
    const lev = /^(\d+)x$/.exec(w);
    if (lev) { out.leverage = Number(lev[1]); continue; }
    if (w === 'sl' || w === 'tp') {
      const v = Number(String(rest[++i] || '').replace('%', ''));
      if (!(v > 0)) no(`"${w}" needs a percent after it, such as ${w} 5.`);
      out[w === 'sl' ? 'stop_loss_pct' : 'take_profit_pct'] = v;
      continue;
    }
    no(`I didn't understand "${rest[i]}". Usage: /${side} BTC 100 3x sl 5 tp 10.`);
  }
  return { input: out, market: m };
}

const describe = i => `${i.side === 'long' ? 'Long' : 'Short'} ${i.coin} ${usd(i.size_usd)} at ${i.leverage}x${i.stop_loss_pct ? `, stop-loss ${i.stop_loss_pct}%` : ''}${i.take_profit_pct ? `, take-profit ${i.take_profit_pct}%` : ''}`;

/** What stops an automatic open for this account right now, or null. Checked when asked and again on Confirm. */
async function openRefusal(account) {
  if (await services.isPaused('perps')) return 'Perps trading is paused by RektBull for now. You can still close positions.';
  const g = await auto.activeGrant(account.id);
  if (!g) return 'Automatic trading isn\'t on for this account: approve RektBull\'s agent on the Perps page first.';
  // Telegram doesn't say where the user is: the place from their last visit to the site, as for any automatic order.
  const where = regions.placeBlocked(g.country, ['hyperliquid', 'hyperliquid_auto']);
  if (where) return `Not opened: ${where}. Open the Perps page on rektbull.com from where you are now to update it. Closing still works.`;
  return null;
}

async function perps(account) {
  const o = await auto.overview(account);
  const g = o.grant && o.grant.status === 'active' && new Date(o.grant.valid_until) > new Date() ? o.grant : null;
  const lines = [g
    ? `Automatic trading is on until ${new Date(g.valid_until).toISOString().slice(0, 16).replace('T', ' ')} UTC: at most ${usd(g.max_trade_usd)} a trade, ${usd(g.max_day_usd)} opened in 24 hours (${usd(o.used_24h_usd)} used), up to ${g.max_leverage}x, ${g.markets ? g.markets.join(', ') : 'any deep market'}.`
    : 'Automatic trading is off. Approve RektBull\'s agent on the Perps page to trade from here.'];
  try {
    const a = await markets.account(account.wallet, { ms: 2000 });
    if (a.positions_error) lines.push(a.positions_error);
    else lines.push(a.positions.length ? `Positions (${a.source}):\n${a.positions.map(p => `${p.side} ${p.coin} ${usd(p.value_usd)} at ${p.leverage}x, entry ${p.entry_px}, PnL ${usd(p.unrealized_pnl_usd)}`).join('\n')}` : 'No open positions.');
  } catch (err) { lines.push(`Positions couldn't be read: ${err.message}`); }
  lines.push('Commands: /long BTC 100 3x sl 5 tp 10, /short, /close BTC, /stopauto.');
  return lines.join('\n\n');
}

/** A private-chat message that's a perps command: handled here. Returns true when it was one. */
async function command(msg) {
  const text = String(msg.text || '').trim();
  const m = COMMAND.exec(text);
  if (!m) return false;
  const chatId = String(msg.chat.id);
  const say = t => bot.send(chatId, t).catch(err => logger.warn('telegram perps: not sent', { error: err.message }));
  try {
    const account = await accountFor(chatId);
    const cmd = m[1].toLowerCase();
    const words = text.split(/\s+/).slice(1);
    if (cmd === 'perps') return say(await perps(account)), true;
    if (cmd === 'stopauto') {
      const r = await auto.revoke(account, {});
      await say(r.revoked ? `Stopped: RektBull no longer uses its agent for this account, and queued orders are cancelled. ${r.on_hyperliquid} Open positions stay open.` : 'Automatic trading was already off.');
      return true;
    }
    if (cmd === 'close') {
      if (!words[0]) no('Usage: /close BTC');
      const list = await markets.markets();
      const mk = list.find(x => x.coin.toLowerCase() === words[0].toLowerCase());
      if (!mk) no(`There's no ${words[0]} market on Hyperliquid.`);
      // A way out: never asked to confirm, never held back by a pause or a region.
      const intent = await auto.queue(account, { coin: mk.coin, side: 'close' }, { source: 'user', reason: 'From Telegram', notifyChat: chatId });
      await say(`Closing ${intent.coin}: sent within about ${Math.round(env.tradeTickMs / 1000)} seconds. The result comes here.`);
      return true;
    }
    // /long and /short: checked now, then a tap on Confirm.
    const why = await openRefusal(account);
    if (why) no(why);
    const { input, market } = await parseOpen(cmd, words);
    if (!market.auto) no(`Automatic trading doesn't open positions in ${market.coin}: ${market.auto_refusal}.`);
    const id = crypto.randomBytes(9).toString('base64url');
    await db.query(`INSERT INTO telegram_pending (id, account_id, chat_id, input, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [id, account.id, chatId, JSON.stringify(input), CONFIRM_MS / 1000]);
    await bot.buttons(chatId, `${describe(input)}?\nRektBull's agent sends it as an immediate-or-cancel order near the mark price, within your automatic-trading limits. Fee: your own ${(await feeRate())}. Confirm within 60 seconds.`,
      [{ text: 'Confirm', data: `tp:ok:${id}` }, { text: 'Cancel', data: `tp:no:${id}` }]);
    return true;
  } catch (err) {
    if (err instanceof TgRefused || err instanceof auto.AutoRefused) await say(err.message);
    else { logger.error('telegram perps failed', { error: err.message }); await say(`That didn't work: ${err.message}`); }
    return true;
  }
}

const feeRate = async () => {
  const b = require('../hyperliquid/relay').builder();
  return b ? require('../../public/hl-core.js').feeRate(b.f) : '0%';
};

/** A tap on Confirm or Cancel ("tp:ok:<id>", "tp:no:<id>"). */
async function callback(q) {
  const [, action, id] = String(q.data || '').split(':');
  const chatId = String(q.message?.chat?.id || '');
  const done = text => Promise.all([
    bot.answer(q.id, text.slice(0, 190)).catch(() => {}),
    q.message ? bot.edit(chatId, q.message.message_id, text).catch(() => {}) : null,
  ]);
  try {
    const { rows: [p] } = await db.query(`UPDATE telegram_pending SET used_at = now() WHERE id = $1 AND chat_id = $2 AND used_at IS NULL RETURNING *, expires_at > now() AS fresh`, [id, chatId]);
    if (!p) return done('Already used.');
    if (action !== 'ok') return done(`Cancelled: ${describe(p.input)}. Nothing was sent.`);
    if (!p.fresh) return done('That confirmation ran out (60 seconds). Send the command again.');
    const account = await accountFor(chatId);
    if (String(account.id) !== String(p.account_id)) return done('This chat now trades for another account. Send the command again.');
    const why = await openRefusal(account);
    if (why) return done(why);
    const intent = await auto.queue(account, p.input, { source: 'user', reason: 'From Telegram', notifyChat: chatId });
    return done(`Queued: ${describe(p.input)}. Sent within about ${Math.round(env.tradeTickMs / 1000)} seconds; the result comes here. (Order ${intent.id.slice(0, 8)})`);
  } catch (err) {
    if (err instanceof TgRefused || err instanceof auto.AutoRefused) return done(err.message);
    logger.error('telegram perps confirm failed', { error: err.message });
    return done(`That didn't work: ${err.message}`);
  }
}

/** An automatic order from Telegram finished: its result, to the chat it came from. */
async function notify(intent) {
  if (!intent?.notify_chat) return;
  const what = intent.side === 'close' ? `Close ${intent.coin}` : describe({ ...intent, size_usd: Number(intent.size_usd), stop_loss_pct: intent.stop_loss_pct && Number(intent.stop_loss_pct), take_profit_pct: intent.take_profit_pct && Number(intent.take_profit_pct) });
  const text = intent.status === 'done'
    ? `Done: ${what}${Number(intent.filled_usd) > 0 ? `, ${usd(intent.filled_usd)} filled` : ', nothing filled'}.`
    : `Not done: ${what}. ${intent.error || ''}`.trim();
  await bot.send(String(intent.notify_chat), text).catch(err => logger.warn('telegram perps: result not sent', { error: err.message }));
}

module.exports = { COMMAND, status, setEnabled, command, callback, notify, parseOpen, TgRefused };

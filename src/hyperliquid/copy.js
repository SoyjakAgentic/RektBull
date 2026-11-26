/**
 * Copy trading on Hyperliquid perps (docs/HYPERLIQUID.md, "Copy trading").
 *
 * A user follows a trader's Hyperliquid address. When that trader opens a
 * position in a market, RektBull opens the same side for the user, at the
 * user's own size, leverage cap and stop-loss. When the trader closes it,
 * RektBull closes the user's copy.
 *
 * It runs on automatic trading (hyperliquid/auto.js): the same agent approval,
 * the same limits enforced by RektBull's trade service (not onchain), and the
 * same checks before each order is signed. The trades are RektBull's decision
 * (source 'agent'), so they carry its fees on decided trades: 0.05% to open,
 * 0.10% to close at a profit, nothing at a loss (relay.js). The trader being
 * copied is paid nothing and is told nothing.
 *
 * What is copied:
 *   - a new position (a market the trader didn't hold, or a flip to the other
 *     side): opened at the follower's trade size;
 *   - that position closed (gone, or flipped): the follower's copy closed.
 * What isn't:
 *   - adds and partial reductions, and positions the trader held before the
 *     follow began;
 *   - anything in a market where the follower holds a position copying didn't
 *     open;
 *   - an open once the price has moved more than HL_COPY_MAX_DRIFT_BPS against
 *     the follower since the trader's entry (it isn't chased).
 * Every copy carries the follower's own stop-loss, so it's protected even if
 * the trader's close is missed or comes late.
 *
 * How the trader is watched: their positions from Hyperliquid's info API
 * (clearinghouseState, weight 2), every HL_COPY_POLL_MS. Hyperliquid's
 * WebSocket allows only 10 users per IP, so it isn't used. A read that fails
 * is never taken as a close. At most HL_COPY_MAX_LEADERS traders are watched
 * (docs/COST_LIMITS.md).
 */
const crypto = require('crypto');
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const services = require('../admin/services');
const hl = require('../providers/hyperliquid');
const markets = require('./markets');
const relay = require('./relay');
const auto = require('./auto');
const H = require('../../public/hl-core.js');

const MAX_FOLLOWS = 3; // traders one account may copy at once
const LOCK_ID = 727003; // one watcher at a time (hyperliquid/auto.js: 727002)

class CopyRefused extends Error {
  constructor(message, status = 422, code = 'copy_refused', extra = null) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const no = (m, status, code, extra) => { throw new CopyRefused(m, status, code, extra); };

const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pct = x => Math.round(x * 10000) / 100;

function whyOff() {
  return auto.whyOff() || (env.hlCopyEnabled ? null : 'Copy trading isn\'t switched on yet (HL_COPY_ENABLED).');
}

function status() {
  const off = whyOff();
  const a = auto.status();
  return {
    enabled: !off, why_off: off, max_follows: MAX_FOLLOWS,
    poll_seconds: env.hlCopyPollMs / 1000, max_drift_pct: env.hlCopyMaxDriftBps / 100,
    fee: a.fee,
    copies: 'A new position the trader opens (or a flip to the other side), at your trade size and up to your leverage cap, with your stop-loss; and its close, when the trader closes.',
    doesnt_copy: 'Adds and partial reductions, positions the trader held before you started, anything in a market where you hold a position copying didn\'t open, and an open once the price has moved past the limit since the trader\'s entry.',
    delay: `RektBull reads the trader's positions every ${env.hlCopyPollMs / 1000} seconds, so a copy is placed about ${env.hlCopyPollMs / 1000} to ${2 * env.hlCopyPollMs / 1000} seconds after the trader's trade, at the price then, never the trader's.`,
    enforced_by_hyperliquid: a.enforced_by_hyperliquid,
    enforced_by_rektbull: `Your automatic-trading limits (per trade, per 24 hours, leverage, markets) and the copy's own settings. These are checked by RektBull's trade service, not onchain.`,
    most_you_can_lose: a.most_you_can_lose,
    not_advice: 'RektBull doesn\'t vet traders: any address can be copied. Past results don\'t predict future ones.',
  };
}

const presentFollow = f => f && ({
  id: f.id, leader: f.leader, trade_usd: Number(f.trade_usd), max_leverage: f.max_leverage,
  stop_loss_pct: Number(f.stop_loss_pct), take_profit_pct: f.take_profit_pct === null ? null : Number(f.take_profit_pct),
  status: f.status, stop_reason: f.stop_reason, created_at: f.created_at, stopped_at: f.stopped_at,
});
const presentTrade = t => ({
  id: t.id, follow_id: t.follow_id, leader: t.leader, coin: t.coin, side: t.side,
  leader_entry_px: t.leader_entry_px === null ? null : Number(t.leader_entry_px), status: t.status, reason: t.reason,
  open_intent: t.open_intent, close_intent: t.close_intent, created_at: t.created_at, closed_at: t.closed_at,
});

/* ── reading traders ── */

/** A Hyperliquid account's open positions. Throws when they can't be read: never taken as "no positions". */
async function positionsOf(user, ms = 0) {
  const s = await hl.info({ type: 'clearinghouseState', user }, { ms });
  if (!s || !Array.isArray(s.assetPositions)) throw new Error('Hyperliquid answered without a positions list');
  return s.assetPositions.map(markets.position).filter(p => p.size > 0);
}

async function part(fn) {
  try { return { ok: true, value: await fn() } } catch (err) { return { ok: false, error: err.message }; }
}

/** A trader's results by Hyperliquid's own portfolio figures (perps only), and what they hold now. */
async function traderProfile(address) {
  if (!markets.isAddress(address)) no('The trader must be a Hyperliquid account address (0x and 40 hex characters).', 400, 'bad_request');
  const user = address.toLowerCase();
  const [state, portfolio] = await Promise.all([
    part(() => hl.info({ type: 'clearinghouseState', user }, { ms: 5000 })),
    part(() => hl.info({ type: 'portfolio', user }, { ttl: 300 })),
  ]);
  const out = { address: user, network: hl.network(), source: hl.SOURCE, note: status().not_advice };
  if (state.ok && Array.isArray(state.value?.assetPositions)) {
    out.account_value_usd = Number(state.value.marginSummary?.accountValue ?? NaN) || 0;
    out.positions = state.value.assetPositions.map(markets.position).filter(p => p.size > 0)
      .map(p => ({ coin: p.coin, side: p.side, value_usd: p.value_usd, entry_px: p.entry_px, leverage: p.leverage, unrealized_pnl_usd: p.unrealized_pnl_usd }));
  } else out.positions_error = `Their positions couldn't be read: ${state.ok ? 'Hyperliquid answered without them' : state.error}`;
  if (portfolio.ok && Array.isArray(portfolio.value)) {
    const windows = Object.fromEntries(portfolio.value);
    const last = h => (Array.isArray(h) && h.length ? Number(h.at(-1)[1]) : null);
    const window = name => (windows[name] ? { pnl_usd: last(windows[name].pnlHistory), volume_usd: Number(windows[name].vlm ?? NaN) || 0 } : null);
    out.results = { day: window('perpDay'), week: window('perpWeek'), month: window('perpMonth'), all_time: window('perpAllTime'), what: 'Profit and loss on perps over each window, from Hyperliquid\'s portfolio figures.' };
  } else out.results_error = `Their results couldn't be read: ${portfolio.ok ? 'Hyperliquid answered without them' : portfolio.error}`;
  return out;
}

/* ── following ── */

function checkSettings(body, g) {
  const trade = Number(body.trade_usd);
  if (!(trade >= auto.MIN_ORDER_USD && trade <= Number(g.max_trade_usd))) no(`trade_usd must be $${auto.MIN_ORDER_USD} to your per-trade amount of $${Number(g.max_trade_usd)}.`, 400, 'bad_request');
  const lev = Number(body.max_leverage ?? 1);
  if (!(Number.isInteger(lev) && lev >= 1 && lev <= g.max_leverage)) no(`max_leverage must be a whole number from 1 to ${g.max_leverage} (your automatic-trading cap).`, 400, 'bad_request');
  const sl = Number(body.stop_loss_pct);
  if (!(sl >= 0.5 && sl < 100 / lev)) no(`Every copy carries your own stop-loss: stop_loss_pct must be at least 0.5 and under ${Math.floor(10000 / lev) / 100} at ${lev}x (a stop past that would trigger after liquidation).`, 400, 'bad_request');
  let tp = null;
  if (body.take_profit_pct !== undefined && body.take_profit_pct !== null && body.take_profit_pct !== '') {
    tp = Number(body.take_profit_pct);
    if (!(tp >= 0.5 && tp <= 500)) no('take_profit_pct must be 0.5 to 500.', 400, 'bad_request');
  }
  return { trade, lev, sl, tp };
}

/** Writes a trader's positions as the last seen, and marks them read. */
async function saveSnapshot(c, leader, positions) {
  await c.query(`DELETE FROM hl_copy_leader_positions WHERE leader = $1`, [leader]);
  for (const p of positions) {
    await c.query(`INSERT INTO hl_copy_leader_positions (leader, coin, side, size, entry_px, leverage) VALUES ($1, $2, $3, $4, $5, $6)`,
      [leader, p.coin, p.side, p.size, p.entry_px, p.leverage]);
  }
  await c.query(`UPDATE hl_copy_leaders SET read_at = now(), checked_at = now(), error = NULL WHERE leader = $1`, [leader]);
}

/**
 * Starts copying a trader. Needs automatic trading on (an active grant) and
 * RektBull's fees on decided trades approved. `before` runs after the checks and
 * before anything is written (the route's region check).
 */
async function follow(account, body, { before } = {}) {
  const off = whyOff();
  if (off) no(off, 503, 'not_enabled');
  const g = await auto.activeGrant(account.id);
  if (!g) no('Copy trading runs on automatic trading: approve RektBull\'s agent, with your limits, in the Automatic trading section first.', 409, 'no_grant');
  if (!markets.isAddress(body.leader)) no('The trader must be a Hyperliquid account address (0x and 40 hex characters).', 400, 'bad_request');
  const leader = body.leader.toLowerCase();
  if (leader === account.wallet.toLowerCase()) no('That\'s your own account.', 400, 'bad_request');
  if (leader === env.hlAgentAddress || leader === relay.builder()?.b) no('That address is RektBull\'s own.', 400, 'bad_request');
  const s = checkSettings(body, g);
  if (relay.builder()) {
    const ap = await markets.approvals(account.wallet, { ms: 0 });
    if (!ap.builder_fee?.auto_approved) {
      const r = relay.decidedRates();
      no(`Copies are trades RektBull decides, so they carry its fees on those: ${H.feeRate(r.open)} to open, ${H.feeRate(r.profitClose)} to close at a profit, nothing at a loss. Approve them first (at most ${H.feeRate(r.profitClose)} of a fill)${ap.builder_fee?.error ? ` (${ap.builder_fee.error})` : ''}.`,
        409, 'fee_not_approved', { fee: { builder: relay.builder().b, tenths_bps: r.profitClose, rate: H.feeRate(r.profitClose) } });
    }
  }
  const { rows: mine } = await db.query(`SELECT leader FROM hl_copy_follows WHERE account_id = $1 AND status = 'active'`, [account.id]);
  if (mine.some(f => f.leader === leader)) no('You already copy this trader.', 409, 'already_following');
  if (mine.length >= MAX_FOLLOWS) no(`You can copy up to ${MAX_FOLLOWS} traders at once. Stop one first.`, 409, 'too_many_follows');
  const { rows: watched } = await db.query(`SELECT DISTINCT leader FROM hl_copy_follows WHERE status = 'active'`);
  if (!watched.some(w => w.leader === leader) && watched.length >= env.hlCopyMaxLeaders) {
    no(`RektBull is watching as many traders as it can for now (${env.hlCopyMaxLeaders}). Copy one that others already copy, or try again later.`, 503, 'copy_full');
  }
  if (before) await before();
  // What they hold now is the starting point: it's never copied.
  let now;
  try { now = await positionsOf(leader); } catch (err) {
    no(`The trader's positions couldn't be read from Hyperliquid (${err.message}), so copying can't start yet. Nothing was set up.`, 503, 'hyperliquid_unavailable');
  }
  const f = await db.tx(async c => {
    const { rows: [fresh] } = await c.query(`INSERT INTO hl_copy_leaders (leader) VALUES ($1) ON CONFLICT (leader) DO NOTHING RETURNING leader`, [leader]);
    const { rows: [known] } = await c.query(`SELECT read_at FROM hl_copy_leaders WHERE leader = $1`, [leader]);
    if (fresh || !known.read_at) await saveSnapshot(c, leader, now);
    const { rows } = await c.query(
      `INSERT INTO hl_copy_follows (id, account_id, leader, trade_usd, max_leverage, stop_loss_pct, take_profit_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [crypto.randomUUID(), account.id, leader, s.trade, s.lev, s.sl, s.tp],
    );
    return rows[0];
  });
  return { follow: presentFollow(f), not_copied: now.map(p => `${p.side} ${p.coin}`), note: now.length ? 'What the trader holds now isn\'t copied: only what they open from here.' : null };
}

/**
 * Stops copying. Copies already open stay open, with their stop-loss, unless
 * `close` asks to close them too: those closes are the user's own decision, so
 * they carry the user's own rate. Stopping is never blocked by a pause.
 */
async function stop(account, id, { close = false } = {}) {
  const { rows: [f] } = await db.query(`SELECT * FROM hl_copy_follows WHERE id = $1 AND account_id = $2`, [id, account.id]);
  if (!f) no('No such copy.', 404, 'not_found');
  let row = f;
  if (f.status === 'active') {
    ({ rows: [row] } = await db.query(`UPDATE hl_copy_follows SET status = 'stopped', stop_reason = 'Stopped by you.', stopped_at = now() WHERE id = $1 RETURNING *`, [id]));
  }
  const closes = [];
  if (close) {
    const { rows: open } = await db.query(`SELECT * FROM hl_copy_trades WHERE follow_id = $1 AND status = 'open'`, [id]);
    for (const t of open) {
      try {
        const intent = await auto.queue(account, { coin: t.coin, side: 'close' }, { source: 'user', reason: `You stopped copying ${short(f.leader)} and closed its copies`, followId: f.id });
        await db.query(`UPDATE hl_copy_trades SET status = 'closed', close_intent = $2, reason = 'Closed when you stopped copying.', closed_at = now() WHERE id = $1`, [t.id, intent.id]);
        closes.push({ coin: t.coin, intent });
      } catch (err) {
        if (!(err instanceof auto.AutoRefused)) throw err;
        closes.push({ coin: t.coin, error: `${err.message} Close it on the Perps page.` });
      }
    }
  }
  return { follow: presentFollow(row), closes };
}

/* ── copying ── */

async function record(f, p, status, reason, openIntent = null) {
  await db.query(
    `INSERT INTO hl_copy_trades (id, follow_id, coin, side, leader_entry_px, status, reason, open_intent, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $6 = 'open' THEN NULL ELSE now() END)`,
    [crypto.randomUUID(), f.id, p.coin, p.side, p.entry_px, status, reason, openIntent],
  );
}

/** The trader opened `p`: open the follower's copy, or record why not. */
async function copyOpen(f, p) {
  const skip = reason => record(f, p, 'skipped', reason);
  if (await services.isPaused('perps') || await services.isPaused('perps_copy')) return skip('Copy trading is paused by RektBull for now: nothing was opened.');
  let held;
  try { held = (await positionsOf(f.wallet)).find(x => x.coin === p.coin) || null; } catch (err) {
    return skip(`Your positions couldn't be read from Hyperliquid (${err.message}), so nothing was opened.`);
  }
  const { rows: [prev] } = await db.query(
    `SELECT t.*, i.status AS open_status FROM hl_copy_trades t LEFT JOIN hl_auto_intents i ON i.id = t.open_intent
     WHERE t.follow_id = $1 AND t.coin = $2 AND t.status = 'open'`, [f.id, p.coin]);
  if (prev && ['queued', 'sending'].includes(prev.open_status)) return; // this open is already on its way (a change seen twice)
  if (prev && !held) {
    await db.query(`UPDATE hl_copy_trades SET status = 'closed', reason = 'Closed outside copying (by its stop-loss or take-profit, or by you).', closed_at = now() WHERE id = $1`, [prev.id]);
  } else if (prev) return skip(`Your earlier copy in ${p.coin} is still open, so it wasn't added to.`);
  // A flip: the copy of the old side is being closed just before this, in order, so it doesn't count as held.
  if (held && held.side !== p.side) {
    const { rows: [closing] } = await db.query(
      `SELECT 1 FROM hl_copy_trades t JOIN hl_auto_intents i ON i.id = t.close_intent
       WHERE t.follow_id = $1 AND t.coin = $2 AND t.side = $3 AND i.status IN ('queued', 'sending') LIMIT 1`, [f.id, p.coin, held.side]);
    if (closing) held = null;
  }
  if (held) return skip(`You hold a ${held.side} in ${p.coin} that copying didn't open, so nothing was added to it.`);
  let m;
  try { m = await markets.market(p.coin); } catch (err) { return skip(`${p.coin}'s price couldn't be read (${err.message}), so nothing was opened.`); }
  if (!m || !(m.mark_px > 0) || !(p.entry_px > 0)) return skip(`There's no price for ${p.coin} to compare with the trader's entry, so nothing was opened.`);
  const drift = (p.side === 'long' ? m.mark_px - p.entry_px : p.entry_px - m.mark_px) / p.entry_px;
  if (drift > env.hlCopyMaxDriftBps / 10000) {
    return skip(`The price had moved ${pct(drift)}% against you since the trader's entry (${p.entry_px}), more than ${env.hlCopyMaxDriftBps / 100}%, so it wasn't chased.`);
  }
  const lev = Math.max(1, Math.min(p.leverage || 1, f.max_leverage, m.max_leverage || 1));
  try {
    const intent = await auto.queue({ id: f.account_id, wallet: f.wallet },
      { coin: p.coin, side: p.side, size_usd: Number(f.trade_usd), leverage: lev, stop_loss_pct: Number(f.stop_loss_pct), take_profit_pct: f.take_profit_pct === null ? null : Number(f.take_profit_pct) },
      { source: 'agent', reason: `Copying ${short(f.leader)}: they opened a ${p.side} in ${p.coin}`, followId: f.id });
    await record(f, p, 'open', null, intent.id);
  } catch (err) {
    if (!(err instanceof auto.AutoRefused)) throw err;
    await skip(err.message);
  }
}

/** The trader closed `p`: close the follower's copy, if copying opened one. */
async function copyClose(f, p) {
  const { rows: [t] } = await db.query(
    `SELECT t.*, i.status AS open_status, i.filled_usd FROM hl_copy_trades t LEFT JOIN hl_auto_intents i ON i.id = t.open_intent
     WHERE t.follow_id = $1 AND t.coin = $2 AND t.status = 'open'`, [f.id, p.coin]);
  if (!t) return;
  if (['failed', 'cancelled'].includes(t.open_status) || (t.open_status === 'done' && !(Number(t.filled_usd) > 0))) {
    return db.query(`UPDATE hl_copy_trades SET status = 'closed', reason = 'The trader closed; your copy hadn\'t opened, so there was nothing to close.', closed_at = now() WHERE id = $1`, [t.id]);
  }
  try {
    const intent = await auto.queue({ id: f.account_id, wallet: f.wallet }, { coin: p.coin, side: 'close' },
      { source: 'agent', reason: `Copying ${short(f.leader)}: they closed their ${p.side} in ${p.coin}`, followId: f.id });
    await db.query(`UPDATE hl_copy_trades SET status = 'closed', close_intent = $2, reason = 'Closed when the trader closed.', closed_at = now() WHERE id = $1`, [t.id, intent.id]);
  } catch (err) {
    if (!(err instanceof auto.AutoRefused)) throw err;
    // The copy stays open with its stop-loss; the user is told to close it.
    await db.query(`UPDATE hl_copy_trades SET reason = $2 WHERE id = $1`, [t.id, `The trader closed, but the close couldn't be queued: ${err.message} Close it on the Perps page.`]);
  }
}

/** Reads one trader and copies what changed since the last read. */
async function watch(leader) {
  await db.query(`UPDATE hl_copy_leaders SET checked_at = now() WHERE leader = $1`, [leader]);
  let now;
  try { now = await positionsOf(leader); } catch (err) {
    await db.query(`UPDATE hl_copy_leaders SET error = $2 WHERE leader = $1`, [leader, String(err.message).slice(0, 300)]);
    return; // never taken as a close
  }
  const { rows: [l] } = await db.query(`SELECT read_at FROM hl_copy_leaders WHERE leader = $1`, [leader]);
  const { rows: prev } = await db.query(`SELECT * FROM hl_copy_leader_positions WHERE leader = $1`, [leader]);
  if (l?.read_at) {
    const before = new Map(prev.map(p => [p.coin, p]));
    const after = new Map(now.map(p => [p.coin, p]));
    const closed = prev.filter(p => after.get(p.coin)?.side !== p.side);
    const opened = now.filter(p => before.get(p.coin)?.side !== p.side);
    if (closed.length || opened.length) {
      const { rows: follows } = await db.query(
        `SELECT f.*, a.wallet FROM hl_copy_follows f JOIN accounts a ON a.id = f.account_id WHERE f.leader = $1 AND f.status = 'active' ORDER BY f.created_at`, [leader]);
      for (const f of follows) {
        // Closes first, so a flip closes the old side before the new one opens.
        for (const p of closed) await copyClose(f, p).catch(err => logger.error('copy close failed', { follow: f.id, coin: p.coin, error: err.message }));
        for (const p of opened) await copyOpen(f, p).catch(err => logger.error('copy open failed', { follow: f.id, coin: p.coin, error: err.message }));
      }
      logger.info('copied a trader', { leader, opened: opened.map(p => p.coin), closed: closed.map(p => p.coin), follows: follows.length });
    }
  }
  // Saved after copying: should this stop partway, the next read sees the same change again, and the one open copy
  // per market (hl_copy_trades_one_open) keeps it from opening twice.
  await db.tx(c => saveSnapshot(c, leader, now));
}

/** One pass: end copies whose automatic trading ended, then read the traders that are due. Run before auto.tick(). */
async function tick() {
  if (whyOff()) return;
  const client = await db.getPool().connect();
  try {
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (!lock.ok) return;
    try {
      await db.query(
        `UPDATE hl_copy_follows f SET status = 'stopped', stopped_at = now(), stop_reason = 'Stopped: your automatic-trading approval ended.'
         WHERE f.status = 'active' AND NOT EXISTS (SELECT 1 FROM hl_auto_grants g WHERE g.account_id = f.account_id AND g.status = 'active' AND g.valid_until > now())`);
      const { rows } = await db.query(
        `SELECT DISTINCT ON (f.leader) f.leader, l.checked_at FROM hl_copy_follows f JOIN hl_copy_leaders l ON l.leader = f.leader
         WHERE f.status = 'active' AND (l.checked_at IS NULL OR l.checked_at < now() - make_interval(secs => $1))`,
        [env.hlCopyPollMs / 1000 - 1]);
      rows.sort((a, b) => (a.checked_at ? +new Date(a.checked_at) : 0) - (b.checked_at ? +new Date(b.checked_at) : 0));
      for (const r of rows.slice(0, env.hlCopyMaxLeaders)) await watch(r.leader).catch(err => logger.error('copy watch failed', { leader: r.leader, error: err.message }));
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

async function overview(account) {
  const [{ rows: follows }, { rows: trades }] = await Promise.all([
    db.query(`SELECT * FROM hl_copy_follows WHERE account_id = $1 ORDER BY status = 'active' DESC, created_at DESC LIMIT 20`, [account.id]),
    db.query(`SELECT t.*, f.leader FROM hl_copy_trades t JOIN hl_copy_follows f ON f.id = t.follow_id WHERE f.account_id = $1 ORDER BY t.created_at DESC LIMIT 50`, [account.id]),
  ]);
  return { ...status(), follows: follows.map(presentFollow), trades: trades.map(presentTrade) };
}

module.exports = { MAX_FOLLOWS, CopyRefused, status, traderProfile, follow, stop, tick, watch, overview };

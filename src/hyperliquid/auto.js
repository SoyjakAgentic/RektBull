/**
 * Automatic trading on Hyperliquid perps (docs/HYPERLIQUID.md).
 *
 * The permission: the user's own wallet approves RektBull's agent wallet
 * (approveAgent, name "rektbull-auto", for at most 30 days). Hyperliquid
 * enforces that an agent can place and cancel orders and change leverage for
 * the account, and can never withdraw or transfer anything. Its key is in
 * Google Cloud KMS (KMS_HL_AGENT_KEY_VERSION) and only the trade service uses it.
 *
 * The user's limits (per trade, per 24 hours, leverage, markets) are enforced
 * HERE, by RektBull's trade service, not onchain: Hyperliquid has no such
 * limits for agents. The page says so, and that the most a user can lose is
 * the margin in their Hyperliquid account.
 *
 * Against a stolen agent key trading the account into an attacker's orders,
 * every automatic order is checked here before it's signed:
 *   - opens only in deep markets (open interest and 24-hour volume above
 *     HL_AUTO_MIN_OPEN_INTEREST_USD and HL_AUTO_MIN_DAY_VOLUME_USD);
 *   - immediate-or-cancel only, priced within HL_AUTO_PRICE_BAND_BPS of the
 *     mark price, and refused when the mark and the oracle disagree by more;
 *   - isolated margin, at most HL_AUTO_MAX_LEVERAGE (and the user's own cap);
 *   - the same relay rules as the page (relay.check): no transfer or
 *     withdrawal is ever signed, and the fee is RektBull's builder code only.
 * These hold for code that goes through this file. Someone who stole the KMS
 * key itself could still trade badly within Hyperliquid's rules, which is why
 * the key is in KMS, usable only by the trade service's account, and every
 * signature is logged first (key_signatures) to match KMS's audit log.
 *
 * One trade service sends at a time (a Postgres advisory lock), so the agent's
 * nonces never collide.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const stops = require('../admin/stops');
const hl = require('../providers/hyperliquid');
const markets = require('./markets');
const relay = require('./relay');
const H = require('../../public/hl-core.js');
const { KmsSigner } = require('../trade/kmsSigner');
const { logSignature } = require('../trade/signers');

const AGENT_NAME = 'rektbull-auto';
const MAX_DAYS = 30;
const DAY = 86400000;
const MIN_ORDER_USD = 10; // Hyperliquid's smallest order
const STALE_MS = 2 * 60 * 1000; // a queued order older than this is refused, not sent at a price nobody saw
const LOCK_ID = 727002;

class AutoRefused extends Error {
  constructor(message, status = 422, code = 'auto_refused') { super(message); this.status = status; this.code = code; }
}
const no = (m, status, code) => { throw new AutoRefused(m, status, code); };

/* ── the agent key ── */

let signerOverride = null;
/** Tests: use this ethers signer instead of KMS. */
const setSignerForTests = s => { signerOverride = s; };

/** RektBull's agent key: KMS in production; a throwaway key on Hyperliquid's testnet only. */
async function agentSigner() {
  let signer = signerOverride;
  if (!signer) {
    if (env.kmsHlAgentKeyVersion) signer = new KmsSigner({ keyVersion: env.kmsHlAgentKeyVersion });
    else if (env.devHlAgentKey) {
      if (env.nodeEnv === 'production') no('DEV_HL_AGENT_KEY is refused in production: use KMS_HL_AGENT_KEY_VERSION.', 503, 'no_agent_key');
      if (hl.isMainnet()) no('DEV_HL_AGENT_KEY may only sign on Hyperliquid\'s testnet.', 503, 'no_agent_key');
      signer = new ethers.Wallet(env.devHlAgentKey);
    } else no('No agent key is set up (KMS_HL_AGENT_KEY_VERSION).', 503, 'no_agent_key');
  }
  const address = (await signer.getAddress()).toLowerCase();
  if (address !== env.hlAgentAddress) no(`The agent key is ${address}, but HL_AGENT_ADDRESS says ${env.hlAgentAddress || 'nothing'}: users approve the latter.`, 503, 'agent_key_mismatch');
  return signer;
}

let lastNonce = 0;
const nextNonce = () => { lastNonce = Math.max(Date.now(), lastNonce + 1); return lastNonce; };

/** Signs an L1 action with the agent key (logged first) and checks it against the relay's rules. */
async function signed(action, intent, wallet) {
  const signer = await agentSigner();
  const nonce = nextNonce();
  const expiresAfter = nonce + 30000;
  const opts = { nonce, mainnet: hl.isMainnet(), expiresAfter };
  await logSignature(env.hlAgentAddress, H.l1Digest(action, opts), `hl:${intent.id}:${action.type}`);
  const payload = { action, nonce, signature: await H.signL1(signer, action, opts), expiresAfter };
  return relay.check(payload, { wallet }).payload; // the same rules as the page: nothing that moves money, RektBull's fee only
}

/* ── what's on, and the settings a user can choose ── */

function whyOff() {
  if (!env.hlEnabled) return 'Perps trading is switched off on this server (HL_ENABLED).';
  if (!env.hlAutoEnabled) return 'Automatic perps trading isn\'t switched on yet (HL_AUTO_ENABLED).';
  if (!env.hlAgentAddress) return 'RektBull\'s agent address isn\'t set (HL_AGENT_ADDRESS).';
  return null;
}

function status() {
  const off = whyOff();
  return {
    enabled: !off, why_off: off,
    agent_address: env.hlAgentAddress || null, agent_name: AGENT_NAME, max_days: MAX_DAYS,
    max_leverage: env.hlAutoMaxLeverage, price_band_pct: env.hlAutoPriceBandBps / 100,
    min_open_interest_usd: env.hlAutoMinOpenInterestUsd, min_day_volume_usd: env.hlAutoMinDayVolumeUsd,
    enforced_by_hyperliquid: 'The agent can place and cancel orders and change leverage, and can never withdraw or transfer funds. It ends when you revoke it or at the expiry you signed.',
    enforced_by_rektbull: 'Your per-trade and 24-hour amounts, the leverage cap, the markets, isolated margin, deep markets only, and prices within a small band of the mark price. These are checked by RektBull\'s trade service, not onchain.',
    most_you_can_lose: 'The margin in your Hyperliquid account. Keep there only what you are willing to let the agent trade.',
  };
}

const COIN = /^[A-Za-z0-9:-]{1,20}$/;
function checkLimits(l) {
  const n = k => Number(l?.[k]);
  const out = { max_trade_usd: n('max_trade_usd'), max_day_usd: n('max_day_usd'), max_leverage: n('max_leverage'), markets: l?.markets ?? null };
  if (!(out.max_trade_usd >= MIN_ORDER_USD && out.max_trade_usd <= 1e6)) no(`max_trade_usd must be $${MIN_ORDER_USD} to $1,000,000.`, 400, 'bad_request');
  if (!(out.max_day_usd >= out.max_trade_usd && out.max_day_usd <= 1e7)) no('max_day_usd must be at least max_trade_usd and at most $10,000,000.', 400, 'bad_request');
  if (!(Number.isInteger(out.max_leverage) && out.max_leverage >= 1 && out.max_leverage <= env.hlAutoMaxLeverage)) no(`max_leverage must be a whole number from 1 to ${env.hlAutoMaxLeverage}.`, 400, 'bad_request');
  if (out.markets !== null) {
    if (!Array.isArray(out.markets) || !out.markets.length || out.markets.length > 50 || !out.markets.every(c => typeof c === 'string' && COIN.test(c))) no('markets must be null (any deep market) or a list of 1 to 50 market names, such as ["BTC", "ETH"].', 400, 'bad_request');
    out.markets = [...new Set(out.markets)];
  }
  return out;
}

/** The validity the signed approval names, in milliseconds, or a refusal. */
function grantValidUntil(action, now = Date.now()) {
  if (action?.type !== 'approveAgent') no('The grant is an approveAgent signed by your wallet.', 400, 'bad_request');
  if (String(action.agentAddress).toLowerCase() !== env.hlAgentAddress) no('This approval names an agent that isn\'t RektBull\'s.', 422, 'wrong_agent');
  const m = new RegExp(`^${AGENT_NAME} valid_until (\\d+)$`).exec(action.agentName || '');
  if (!m) no(`The approval must name the agent "${AGENT_NAME}" with an expiry.`, 422, 'bad_agent_name');
  const until = Number(m[1]);
  if (until < now + 60 * 60 * 1000 || until > now + MAX_DAYS * DAY + 10 * 60 * 1000) no(`An automatic-trading approval runs from an hour to ${MAX_DAYS} days.`, 422, 'bad_expiry');
  return until;
}

const presentGrant = g => g && ({
  id: g.id, status: g.status, agent_address: g.agent_address, valid_until: g.valid_until,
  max_trade_usd: Number(g.max_trade_usd), max_day_usd: Number(g.max_day_usd), max_leverage: g.max_leverage, markets: g.markets,
  created_at: g.created_at, ended_at: g.ended_at,
});
const presentIntent = r => ({
  id: r.id, coin: r.coin, side: r.side, size_usd: r.size_usd === null ? null : Number(r.size_usd), leverage: r.leverage,
  stop_loss_pct: r.stop_loss_pct === null ? null : Number(r.stop_loss_pct), take_profit_pct: r.take_profit_pct === null ? null : Number(r.take_profit_pct),
  source: r.source, reason: r.reason, status: r.status, result: r.result, filled_usd: r.filled_usd === null ? null : Number(r.filled_usd), error: r.error,
  created_at: r.created_at, finished_at: r.finished_at,
});

async function activeGrant(accountId) {
  const { rows } = await db.query(`SELECT * FROM hl_auto_grants WHERE account_id = $1 AND status = 'active' AND valid_until > now() LIMIT 1`, [accountId]);
  return rows[0] || null;
}

/* ── grant and revoke ── */

/**
 * The user's wallet approved RektBull's agent: passes the signed approval on
 * to Hyperliquid and records the limits. `before` runs after the checks and
 * before anything is sent (the route's region check).
 */
async function grant(account, body, { before } = {}) {
  const off = whyOff();
  if (off) no(off, 503, 'not_enabled');
  if (await stops.isStopped('auto_trading')) no('Automatic trading is paused by RektBull for now.', 503, 'stopped');
  const limits = checkLimits(body?.limits);
  const until = grantValidUntil(body?.approval?.action);
  await relay.send(body.approval, { wallet: account.wallet, before }); // checks the user's own wallet signed it
  const id = crypto.randomUUID();
  const g = await db.tx(async c => {
    await c.query(`UPDATE hl_auto_grants SET status = 'revoked', ended_at = now() WHERE account_id = $1 AND status = 'active'`, [account.id]);
    const { rows } = await c.query(
      `INSERT INTO hl_auto_grants (id, account_id, wallet, agent_address, valid_until, max_trade_usd, max_day_usd, max_leverage, markets)
       VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7, $8, $9) RETURNING *`,
      [id, account.id, account.wallet, env.hlAgentAddress, until, limits.max_trade_usd, limits.max_day_usd, limits.max_leverage, limits.markets],
    );
    return rows[0];
  });
  return presentGrant(g);
}

/**
 * Ends the grant: RektBull stops using it at once and cancels what's queued.
 * With `approval` (the page's replacement agent, whose key the browser threw
 * away), Hyperliquid drops RektBull's agent too.
 */
async function revoke(account, body = {}) {
  const { rows } = await db.query(`UPDATE hl_auto_grants SET status = 'revoked', ended_at = now() WHERE account_id = $1 AND status = 'active' RETURNING *`, [account.id]);
  await db.query(`UPDATE hl_auto_intents SET status = 'cancelled', error = 'The automatic-trading grant was revoked.', finished_at = now() WHERE account_id = $1 AND status = 'queued'`, [account.id]);
  let onHyperliquid = null;
  if (body.approval) {
    const a = body.approval.action;
    if (a?.type !== 'approveAgent' || !new RegExp(`^${AGENT_NAME}( |$)`).test(a.agentName || '') || String(a.agentAddress).toLowerCase() === env.hlAgentAddress) {
      no(`To end RektBull's agent on Hyperliquid, approve a different address under the name "${AGENT_NAME}".`, 400, 'bad_request');
    }
    await relay.send(body.approval, { wallet: account.wallet });
    onHyperliquid = 'RektBull\'s agent is replaced on Hyperliquid by one nobody holds.';
  }
  return { revoked: rows.length > 0, grant: presentGrant(rows[0]) || null, on_hyperliquid: onHyperliquid || 'RektBull stopped using the agent. To remove it on Hyperliquid too, sign the replacement on the Perps page.' };
}

/* ── queueing an order ── */

async function usedToday(accountId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(COALESCE(filled_usd, size_usd)), 0) AS used FROM hl_auto_intents
     WHERE account_id = $1 AND side <> 'close' AND status IN ('queued', 'sending', 'done') AND created_at > now() - interval '24 hours'`,
    [accountId],
  );
  return Number(rows[0].used);
}

/**
 * Queues an automatic order: { coin, side: long|short|close, size_usd, leverage,
 * stop_loss_pct?, take_profit_pct? }. Checked now against the grant; checked
 * again against the market just before it's signed.
 */
async function queue(account, input, { source = 'user', reason = null } = {}) {
  const off = whyOff();
  if (off) no(off, 503, 'not_enabled');
  if (await stops.isStopped('auto_trading')) no('Automatic trading is paused by RektBull for now. You can still trade on the Perps page yourself.', 503, 'stopped');
  const g = await activeGrant(account.id);
  if (!g) no('There is no active automatic-trading grant for this account. Approve RektBull\'s agent on the Perps page first.', 409, 'no_grant');
  const coin = String(input?.coin || '');
  if (!COIN.test(coin)) no('coin must be a market name, such as BTC.', 400, 'bad_request');
  const side = input?.side;
  if (!['long', 'short', 'close'].includes(side)) no('side must be long, short or close.', 400, 'bad_request');
  if (g.markets && !g.markets.includes(coin)) no(`Your grant only covers ${g.markets.join(', ')}.`, 422, 'market_not_allowed');
  const m = await markets.market(coin);
  let size = null; let lev = null; let sl = null; let tp = null;
  if (side !== 'close') {
    const refusal = markets.autoRefusal(m);
    if (refusal) no(`Automatic trading doesn't open positions in ${coin}: ${refusal}.`, 422, 'market_not_deep');
    size = Number(input.size_usd);
    if (!(size >= MIN_ORDER_USD)) no(`size_usd must be at least $${MIN_ORDER_USD}, Hyperliquid's smallest order.`, 400, 'bad_request');
    if (size > Number(g.max_trade_usd)) no(`$${size} is over your per-trade amount of $${Number(g.max_trade_usd)}.`, 422, 'over_trade_limit');
    const used = await usedToday(account.id);
    if (used + size > Number(g.max_day_usd)) no(`That would open $${used + size} in 24 hours, over your $${Number(g.max_day_usd)} a day.`, 422, 'over_day_limit');
    lev = Number(input.leverage ?? 1);
    const cap = Math.min(g.max_leverage, m.max_leverage || 1);
    if (!(Number.isInteger(lev) && lev >= 1 && lev <= cap)) no(`leverage must be a whole number from 1 to ${cap} (your grant's cap and ${coin}'s).`, 422, 'over_leverage');
    if (input.stop_loss_pct !== undefined && input.stop_loss_pct !== null) {
      sl = Number(input.stop_loss_pct);
      if (!(sl >= 0.5 && sl < 100 / lev)) no(`stop_loss_pct must be at least 0.5 and under ${Math.floor(10000 / lev) / 100} at ${lev}x (a stop past that would trigger after liquidation).`, 400, 'bad_request');
    }
    if (input.take_profit_pct !== undefined && input.take_profit_pct !== null) {
      tp = Number(input.take_profit_pct);
      if (!(tp >= 0.5 && tp <= 500)) no('take_profit_pct must be 0.5 to 500.', 400, 'bad_request');
    }
  }
  const { rows } = await db.query(
    `INSERT INTO hl_auto_intents (id, account_id, grant_id, coin, side, size_usd, leverage, stop_loss_pct, take_profit_pct, source, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [crypto.randomUUID(), account.id, g.id, coin, side, size, lev, sl, tp, source === 'agent' ? 'agent' : 'user', reason ? String(reason).slice(0, 500) : null],
  );
  return presentIntent(rows[0]);
}

/* ── sending ── */

async function fail(intent, message) {
  await db.query(`UPDATE hl_auto_intents SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [intent.id, message]);
  logger.info('automatic perps order refused', { intent: intent.id, reason: message });
}

async function send(payload) {
  const answer = await hl.exchange(payload);
  if (answer?.status !== 'ok') no(`Hyperliquid refused it: ${typeof answer?.response === 'string' ? answer.response : 'no reason given'}`, 422, 'hyperliquid_refused');
  return relay.summarize(answer) || [];
}

const band = () => env.hlAutoPriceBandBps / 10000;
/** A trigger price `pct` percent away from `ref`, up or down, on Hyperliquid's tick. */
const triggerAt = (ref, pct, up, szDecimals) => H.formatPrice(ref * (1 + (up ? 1 : -1) * pct / 100), szDecimals);

/** Signs and sends one queued order. Every check is made again against the market as it is now. */
async function execute(row) {
  const { rows: [intent] } = await db.query(`UPDATE hl_auto_intents SET status = 'sending' WHERE id = $1 AND status = 'queued' RETURNING *`, [row.id]);
  if (!intent) return; // cancelled or taken meanwhile
  try {
    const { rows: [g] } = await db.query(`SELECT * FROM hl_auto_grants WHERE id = $1`, [intent.grant_id]);
    if (!g || g.status !== 'active' || new Date(g.valid_until).getTime() < Date.now() + 30000) return fail(intent, 'The automatic-trading grant ended before this was sent. Nothing was sent.');
    if (Date.now() - new Date(intent.created_at).getTime() > STALE_MS) return fail(intent, 'Not sent: it waited too long, and the price has moved since. Nothing was sent.');
    const m = await markets.market(intent.coin, { ms: 0 });
    const mark = m.mark_px;
    if (!(mark > 0) || !(m.oracle_px > 0)) return fail(intent, `Hyperliquid shows no mark or oracle price for ${intent.coin} right now. Nothing was sent.`);
    if (Math.abs(mark - m.oracle_px) / m.oracle_px > band()) return fail(intent, `${intent.coin}'s mark price (${mark}) and oracle price (${m.oracle_px}) are more than ${band() * 100}% apart, so the market may be off. Nothing was sent.`);
    const acct = await markets.account(g.wallet, { ms: 0 });
    if (acct.positions_error) return fail(intent, `${acct.positions_error}. Nothing was sent.`);
    const pos = acct.positions.find(p => p.coin === intent.coin) || null;
    const results = [];

    if (intent.side === 'close') {
      if (!pos) return fail(intent, `There is no ${intent.coin} position to close.`);
      const isBuy = pos.side === 'short';
      const order = H.orderWire({ asset: m.asset, isBuy, px: H.slippagePrice(mark, isBuy, band(), m.sz_decimals), sz: H.formatSize(pos.size, m.sz_decimals), reduceOnly: true, tif: 'Ioc', cloid: H.cloid() });
      // A close carries the fee only where it's approved: a position can always be closed (relay.js).
      const b = relay.builder() && (await markets.approvals(g.wallet, { ms: 0 })).builder_fee?.approved ? relay.builder() : null;
      results.push(...await send(await signed(H.orderAction([order], { builder: b }), intent, g.wallet)));
    } else {
      const refusal = markets.autoRefusal(m);
      if (refusal) return fail(intent, `Not opened: ${intent.coin} is no longer deep enough for automatic trading (${refusal}).`);
      const isBuy = intent.side === 'long';
      if (pos && pos.side !== intent.side) return fail(intent, `You hold a ${pos.side} in ${intent.coin}; an automatic ${intent.side} would close or flip it. Close it first. Nothing was sent.`);
      if (pos && pos.margin_mode !== 'isolated') return fail(intent, `You hold a cross-margin ${intent.coin} position; automatic trading only uses isolated margin. Nothing was sent.`);
      if (pos && pos.leverage > g.max_leverage) return fail(intent, `Your ${intent.coin} position uses ${pos.leverage}x, over your grant's ${g.max_leverage}x. Nothing was sent.`);
      const b = relay.builder();
      if (b) {
        const ap = await markets.approvals(g.wallet, { ms: 0 });
        if (!ap.builder_fee?.approved) return fail(intent, `RektBull's ${H.feeRate(b.f)} fee isn't approved on this account${ap.builder_fee?.error ? ` (${ap.builder_fee.error})` : ''}. Approve it on the Perps page. Nothing was sent.`);
      }
      if (!pos) {
        const lev = H.updateLeverageAction({ asset: m.asset, isCross: false, leverage: intent.leverage });
        await send(await signed(lev, intent, g.wallet));
      }
      const sz = H.formatSize(Number(intent.size_usd) / mark, m.sz_decimals);
      if (!(Number(sz) > 0)) return fail(intent, `$${Number(intent.size_usd)} is less than the smallest ${intent.coin} order. Nothing was sent.`);
      const entry = H.orderWire({ asset: m.asset, isBuy, px: H.slippagePrice(mark, isBuy, band(), m.sz_decimals), sz, reduceOnly: false, tif: 'Ioc', cloid: H.cloid() });
      const filled = await send(await signed(H.orderAction([entry], { builder: b }), intent, g.wallet));
      results.push(...filled);
      const f = filled.find(x => x.filled);
      if (f && (intent.stop_loss_pct || intent.take_profit_pct)) {
        // The stop and the take-profit: reduce-only, so they can only close what was opened.
        const exits = [];
        const fsz = H.formatSize(f.size, m.sz_decimals);
        if (intent.stop_loss_pct) {
          const t = triggerAt(f.avg_px, Number(intent.stop_loss_pct), !isBuy, m.sz_decimals);
          exits.push(H.orderWire({ asset: m.asset, isBuy: !isBuy, px: H.slippagePrice(Number(t), !isBuy, 0.1, m.sz_decimals), sz: fsz, reduceOnly: true, trigger: { triggerPx: t, isMarket: true, tpsl: 'sl' }, cloid: H.cloid() }));
        }
        if (intent.take_profit_pct) {
          const t = triggerAt(f.avg_px, Number(intent.take_profit_pct), isBuy, m.sz_decimals);
          exits.push(H.orderWire({ asset: m.asset, isBuy: !isBuy, px: H.slippagePrice(Number(t), !isBuy, 0.1, m.sz_decimals), sz: fsz, reduceOnly: true, trigger: { triggerPx: t, isMarket: true, tpsl: 'tp' }, cloid: H.cloid() }));
        }
        try {
          results.push(...(await send(await signed(H.orderAction(exits, { builder: null }), intent, g.wallet))).map(x => ({ ...x, exit: true })));
        } catch (err) {
          results.push({ exit: true, error: `The position opened, but the stop or take-profit couldn't be placed: ${err.message}. Set one on the Perps page.` });
        }
      }
    }
    const filledUsd = results.filter(x => x.filled && !x.exit).reduce((s, x) => s + x.size * x.avg_px, 0);
    const refusedAll = results.length && results.filter(x => !x.exit).every(x => x.error);
    await db.query(
      `UPDATE hl_auto_intents SET status = $2, result = $3, filled_usd = $4, error = $5, finished_at = now() WHERE id = $1`,
      [intent.id, refusedAll ? 'failed' : 'done', JSON.stringify(results), Math.round(filledUsd * 100) / 100, refusedAll ? results.map(x => x.error).join(' ') : null],
    );
    logger.info('automatic perps order sent', { intent: intent.id, filled_usd: filledUsd });
    const b = relay.builder();
    if (b && filledUsd > 0 && intent.side !== 'close') {
      await require('../rewards/points').safeCredit({ accountId: intent.account_id, source: 'perps_auto', ref: intent.id, feeUsd: filledUsd * b.f / 100000 });
    }
  } catch (err) {
    await fail(intent, err instanceof AutoRefused || err.isHyperliquid ? err.message : `Not sent: ${err.message}`);
  }
}

/** One pass of the trade service: end lapsed grants, honour the emergency stop, send what's queued. */
async function tick() {
  if (!env.hlAutoEnabled) return;
  const client = await db.getPool().connect();
  try {
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (!lock.ok) return;
    try {
      await db.query(`UPDATE hl_auto_grants SET status = 'expired', ended_at = now() WHERE status = 'active' AND valid_until <= now()`);
      // An order that was being sent when a service stopped: its outcome is unknown, so it isn't sent again.
      await db.query(`UPDATE hl_auto_intents SET status = 'failed', error = 'The trade service stopped while sending this; check your positions on the Perps page.', finished_at = now() WHERE status = 'sending' AND created_at < now() - interval '10 minutes'`);
      if (await stops.isStopped('auto_trading')) {
        await db.query(`UPDATE hl_auto_intents SET status = 'cancelled', error = 'Cancelled: automatic trading was paused by RektBull. Nothing was sent.', finished_at = now() WHERE status = 'queued'`);
        return;
      }
      const { rows } = await db.query(`SELECT * FROM hl_auto_intents WHERE status = 'queued' ORDER BY created_at LIMIT 10`);
      for (const i of rows) await execute(i).catch(err => logger.error('automatic perps order failed', { intent: i.id, error: err.message }));
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

async function overview(account) {
  const [g, { rows }] = await Promise.all([
    db.query(`SELECT * FROM hl_auto_grants WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`, [account.id]),
    db.query(`SELECT * FROM hl_auto_intents WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50`, [account.id]),
  ]);
  const grantRow = g.rows[0] || null;
  return { ...status(), grant: presentGrant(grantRow), used_24h_usd: grantRow ? await usedToday(account.id) : 0, intents: rows.map(presentIntent) };
}

async function cancel(account, id) {
  const { rows } = await db.query(`UPDATE hl_auto_intents SET status = 'cancelled', finished_at = now() WHERE id = $1 AND account_id = $2 AND status = 'queued' RETURNING *`, [id, account.id]);
  if (!rows.length) no('Only a queued order can be cancelled.', 409, 'not_queued');
  return presentIntent(rows[0]);
}

module.exports = {
  AGENT_NAME, MAX_DAYS, AutoRefused, status, checkLimits, grantValidUntil, grant, revoke, queue, execute, tick, overview, cancel,
  setSignerForTests, _resetNonce: () => { lastNonce = 0; },
};

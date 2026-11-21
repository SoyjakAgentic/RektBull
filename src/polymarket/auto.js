/**
 * Automatic Polymarket trading through RektBull's Session Key
 * (docs/POLYMARKET.md, "Automatic trading"; docs.polymarket.com/trading/session-keys).
 *
 * The permission: the user's own key signs `authorizeSessionSigner` for
 * RektBull's key on their Deposit Wallet, sent through Polymarket's relayer.
 * Polymarket enforces that the key can trade and never withdraw. Its term is a
 * fixed 180 days (Polymarket allows no other); RektBull stops at the user's own
 * earlier date. Polymarket has no onchain per-order or per-day limits, so the
 * user's limits are kept by RektBull here, not onchain, and the page says so.
 * Revoking cancels the key's open orders; RektBull also stops at once.
 *
 * What it places: only entries, from a researched AI forecast (forecasts/),
 * when the AI's probability beats the price by `auto_edge_pct` points at
 * medium or high confidence: a fill-and-kill buy at no worse than the
 * forecast's price limit, between `auto_min_order_usd` and the user's limits.
 * Positions are held to resolution or sold by the user. The fee, from Safety
 * Pro AI credits, is `auto_fee_pct` of what fills, at least `auto_fee_min_usd`,
 * charged only when an entry fills.
 *
 * Orders are signed by RektBull's key (KMS in production) with the Deposit
 * Wallet as maker and signer, wrapped for the Deposit Wallet and in the session
 * envelope, and sent with RektBull's key's own CLOB API credentials.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const pm = require('../providers/polymarket');
const orders = require('./orders');
const wallets = require('./wallets');
const desk = require('./desk');
const { CHAIN_ID } = require('./contracts');

const DAY = 86400000;
const MAX_STOP_DAYS = 179; // inside Polymarket's fixed 180 days

class AutoRefused extends Error {
  constructor(message, status = 422, code = 'auto_refused') { super(message); this.status = status; this.code = code; }
}
const no = (m, status, code) => { throw new AutoRefused(m, status, code); };
const fsettings = () => require('../forecasts/settings').get();

/* ── RektBull's Session Key ── */

let signerOverride = null;
const setSignerForTests = s => { signerOverride = s; };
async function sessionSigner() {
  let s = signerOverride;
  if (!s) {
    if (env.kmsPolymarketSessionKeyVersion) s = new (require('../trade/kmsSigner').KmsSigner)({ keyVersion: env.kmsPolymarketSessionKeyVersion });
    else if (env.devPolymarketSessionKey && env.nodeEnv !== 'production') s = new ethers.Wallet(env.devPolymarketSessionKey);
    else no('RektBull\'s Polymarket Session Key isn\'t set up (KMS_POLYMARKET_SESSION_KEY_VERSION).', 503, 'not_set_up');
  }
  const address = (await s.getAddress()).toLowerCase();
  if (address !== env.polymarketSessionAddress) no(`The Session Key is ${address}, but POLYMARKET_SESSION_ADDRESS says ${env.polymarketSessionAddress || 'nothing'}.`, 503, 'not_set_up');
  return s;
}

/** RektBull's key's own CLOB API credentials (L1 ClobAuth signed by the key), kept in memory only. */
let creds = null;
async function clobCredentials() {
  if (creds) return creds;
  const s = await sessionSigner();
  const address = ethers.getAddress(await s.getAddress());
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await s.signTypedData({ name: 'ClobAuthDomain', version: '1', chainId: CHAIN_ID },
    { ClobAuth: [{ name: 'address', type: 'address' }, { name: 'timestamp', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'message', type: 'string' }] },
    { address, timestamp, nonce: 0, message: 'This message attests that I control the given wallet' });
  const headers = { POLY_ADDRESS: address, POLY_SIGNATURE: signature, POLY_TIMESTAMP: timestamp, POLY_NONCE: '0' };
  let out = await pm.http.get(`${pm.CLOB}/auth/derive-api-key`, { headers, timeout: 10000, validateStatus: () => true });
  if (!out.data?.apiKey) out = await pm.http.post(`${pm.CLOB}/auth/api-key`, '', { headers, timeout: 10000, validateStatus: () => true });
  if (!out.data?.apiKey) no(`Polymarket gave RektBull's key no API credentials: ${out.data?.error || out.status}`, 502, 'clob_auth');
  creds = { key: out.data.apiKey, secret: out.data.secret, passphrase: out.data.passphrase, address };
  return creds;
}
const resetCredentials = () => { creds = null; };

/** POST /order with L2 headers: HMAC-SHA256 of timestamp + method + path + body, URL-safe base64. */
async function postOrder(body) {
  const c = await clobCredentials();
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', Buffer.from(c.secret, 'base64')).update(timestamp + 'POST' + '/order' + raw).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const out = await pm.http.post(`${pm.CLOB}/order`, raw, {
    headers: { 'content-type': 'application/json', POLY_ADDRESS: c.address, POLY_SIGNATURE: sig, POLY_TIMESTAMP: timestamp, POLY_API_KEY: c.key, POLY_PASSPHRASE: c.passphrase },
    timeout: 15000, validateStatus: () => true, transformRequest: [d => d],
  });
  if (out.status === 401) resetCredentials();
  return out.data || {};
}

/* ── what's on, and what the user is told ── */

function whyOff() {
  if (!env.polymarketEnabled) return 'Polymarket trading is switched off on this server.';
  if (!env.polymarketAutoEnabled) return 'Automatic Polymarket trading isn\'t switched on yet (POLYMARKET_AUTO_ENABLED).';
  if (!env.polymarketSessionAddress) return 'RektBull\'s Session Key address isn\'t set (POLYMARKET_SESSION_ADDRESS).';
  if (!pm.builderConfigured()) return 'RektBull\'s Builder API key isn\'t set, so Session Keys can\'t be authorized through Polymarket\'s relayer.';
  return null;
}

function disclosures() {
  const s = fsettings();
  return {
    duration: 'Polymarket gives a Session Key a fixed term of 180 days: it can\'t be shorter. RektBull stops placing anything at the earlier date you choose, and you can end the key on Polymarket at any time.',
    can_do: 'The key can place orders on Polymarket\'s order book for your Polymarket wallet. Polymarket doesn\'t let it withdraw your money.',
    limits: 'Your per-order and daily limits, your stop date and the markets are enforced by RektBull\'s servers, not onchain: Polymarket has no such limits for Session Keys.',
    what_it_does: `Only buys, from a researched AI forecast at medium or high confidence that beats the price by at least ${s.auto_edge_pct} points, as a fill-and-kill order at no worse than the forecast's limit price, at least $${s.auto_min_order_usd}. It never sells: positions are held until the market resolves, or you sell them yourself.`,
    fee: `RektBull's fee is ${s.auto_fee_pct}% of each automated buy that fills, at least $${s.auto_fee_min_usd}, from your Safety Pro AI credits. Nothing is charged for an order that doesn't fill. Polymarket's own fee, RektBull's builder fee, and the profit share on winnings redeemed through RektBull apply as usual.`,
    revoking: 'Ending the key stops RektBull at once, and Polymarket cancels any open orders it placed (this can take a few minutes).',
    servers: 'Automated orders are sent from RektBull\'s servers, not your browser, so RektBull checks your country when you turn this on and each time you come back, and stops if you\'re in a place where Polymarket isn\'t offered.',
    most_you_can_lose: 'What\'s in your Polymarket wallet. Keep there only what you are willing to let it trade.',
    not_advice: 'The AI can be wrong. Check its public track record before turning this on. Not financial advice.',
  };
}

const present = r => r && ({
  id: r.id, status: r.status, wallet: r.wallet, session_signer: r.session_signer, stop_at: r.stop_at, valid_until: new Date(Number(r.valid_until) * 1000).toISOString(),
  max_order_usd: Number(r.max_order_usd), max_day_usd: Number(r.max_day_usd), country: r.country, created_at: r.created_at, ended_at: r.ended_at,
});

async function current(accountId) {
  const { rows: [r] } = await db.query(`SELECT * FROM polymarket_sessions WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`, [accountId]);
  return r || null;
}

/** The page's view; records where the signed-in user is, which the automation checks before each order. */
async function overview(account, country = null) {
  const s = await current(account.id);
  if (s && ['pending', 'active'].includes(s.status)) await db.query('UPDATE polymarket_sessions SET country = $2, seen_at = now() WHERE id = $1', [s.id, country]);
  const { rows } = await db.query(`SELECT * FROM polymarket_auto_orders WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50`, [account.id]);
  return {
    enabled: !whyOff(), why_off: whyOff(), automation_on: !!fsettings().polymarket_auto,
    disclosures: disclosures(), session: present(s), max_stop_days: MAX_STOP_DAYS, min_order_usd: fsettings().auto_min_order_usd,
    orders: rows.map(o => ({ id: o.id, market: o.market, outcome: o.outcome, amount_usd: Number(o.amount_usd), price_limit: Number(o.price_limit), status: o.status, filled_usd: o.filled_usd === null ? null : Number(o.filled_usd), fee_usd: o.fee_usd === null ? null : Number(o.fee_usd), error: o.error, created_at: o.created_at })),
  };
}

/* ── turning it on and off ── */

/** Prepares the authorization the user's own key signs. `regionOk` is the route's check, made now. */
async function start(account, input, { country }) {
  const off = whyOff();
  if (off) no(off, 503, 'not_enabled');
  if (!input.accept) no('Read the disclosures and accept them (accept: true) to turn this on.', 400, 'not_accepted');
  const s = fsettings();
  const maxOrder = Number(input.max_order_usd); const maxDay = Number(input.max_day_usd); const days = Number(input.stop_days);
  if (!(maxOrder >= s.auto_min_order_usd && maxOrder <= 100000)) no(`max_order_usd must be $${s.auto_min_order_usd} to $100,000.`, 400, 'bad_request');
  if (!(maxDay >= maxOrder && maxDay <= 1000000)) no('max_day_usd must be at least max_order_usd.', 400, 'bad_request');
  if (!(Number.isInteger(days) && days >= 1 && days <= MAX_STOP_DAYS)) no(`stop_days must be 1 to ${MAX_STOP_DAYS}.`, 400, 'bad_request');
  const t = await wallets.prepare(account, 'session_authorize', { session_signer: env.polymarketSessionAddress, wallet_type: 'deposit' });
  await db.query(`UPDATE polymarket_sessions SET status = 'ended', ended_at = now() WHERE account_id = $1 AND status = 'pending'`, [account.id]);
  const id = crypto.randomUUID();
  await db.query(`INSERT INTO polymarket_sessions (id, account_id, signer, wallet, session_signer, valid_until, stop_at, max_order_usd, max_day_usd, batch_id, country, seen_at)
    VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7), $8, $9, $10, $11, now())`,
  [id, account.id, String(account.wallet).toLowerCase(), String(t.wallet).toLowerCase(), env.polymarketSessionAddress, t.detail.valid_until, days, maxOrder, maxDay, t.id, country]);
  return { session_id: id, ...t, disclosures: disclosures() };
}

/** Called by wallets.progress when a session batch settles. */
async function batchSettled(b) {
  if (b.kind === 'session_authorize') {
    await db.query(`UPDATE polymarket_sessions SET status = $2, ended_at = CASE WHEN $2 = 'failed' THEN now() END WHERE batch_id = $1 AND status = 'pending'`, [b.id, b.status === 'confirmed' ? 'active' : 'failed']);
  }
}

/** Stops RektBull at once; returns the revocation for the user's key to sign, so Polymarket ends the key too. */
async function stop(account) {
  const { rows } = await db.query(`UPDATE polymarket_sessions SET status = 'revoked', ended_at = now() WHERE account_id = $1 AND status IN ('pending', 'active') RETURNING *`, [account.id]);
  let revoke = null;
  if (rows.length) revoke = await wallets.prepare(account, 'session_revoke', { session_signer: rows[0].session_signer, wallet_type: 'deposit' }).catch(err => ({ error: err.message }));
  return { stopped: rows.length > 0, revoke };
}

/* ── placing an automated entry ── */

const feeFor = (filledUsd, s = fsettings()) => Math.round(Math.max(s.auto_fee_min_usd, filledUsd * s.auto_fee_pct / 100) * 100) / 100;

async function usedToday(sessionId) {
  const { rows: [r] } = await db.query(`SELECT COALESCE(SUM(COALESCE(filled_usd, 0)), 0) AS u FROM polymarket_auto_orders WHERE session_id = $1 AND created_at > now() - interval '24 hours'`, [sessionId]);
  return Number(r.u);
}

/** Can this session trade right now? A reason, or null. */
async function blockedReason(sess) {
  if (sess.status !== 'active') return 'the key isn\'t active';
  if (new Date(sess.stop_at) <= new Date()) return 'past the user\'s stop date';
  if (Number(sess.valid_until) * 1000 <= Date.now() + 3600000) return 'Polymarket\'s 180 days are nearly up';
  const regions = require('../compliance/regions');
  const list = regions.countries('polymarket');
  if (!list.length) return null;
  const c = sess.country; // CA, or CA-ON when the region was known
  if (!c) return 'the user\'s country isn\'t known';
  const base = c.slice(0, 2);
  if (list.includes(base) || list.includes(c)) return `Polymarket isn't offered in ${c}`;
  if (c.length === 2 && list.some(x => x.startsWith(base + '-'))) return `Polymarket isn't offered in parts of ${base}, and the user's region isn't known`;
  return null;
}

/**
 * Places one automated entry for one session from a researched forecast's
 * plan ({ side, assetId, priceLimit }). Returns the order row (filled,
 * unfilled, refused or failed), or null when nothing was attempted.
 */
async function place(sess, forecast, plan) {
  const s = fsettings();
  const why = await blockedReason(sess);
  if (why) return null;
  const proposals = require('../forecasts/proposals');
  if (!(await proposals.canPay(sess.account_id))) return null; // no AI credits left for the fee
  const room = Number(sess.max_day_usd) - await usedToday(sess.id);
  const amount = Math.floor(Math.min(Number(sess.max_order_usd), room) * 100) / 100;
  if (amount < s.auto_min_order_usd) return null;
  const id = crypto.randomUUID();
  const { rows: [row] } = await db.query(`INSERT INTO polymarket_auto_orders (id, account_id, session_id, forecast_id, market, asset_id, outcome, amount_usd, price_limit)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (account_id, forecast_id) DO NOTHING RETURNING *`,
  [id, sess.account_id, sess.id, forecast.id, forecast.market, plan.assetId, plan.side, amount, plan.priceLimit]);
  if (!row) return null; // this forecast already traded for this user
  const finish = async (status, extra = {}) => {
    const { rows: [u] } = await db.query(`UPDATE polymarket_auto_orders SET status = $2, clob_order_id = $3, filled_usd = $4, fee_usd = $5, fee_paid_from = $6, error = $7 WHERE id = $1 RETURNING *`,
      [id, status, extra.order_id || null, extra.filled_usd ?? null, extra.fee_usd ?? null, extra.paid_from || null, extra.error ? String(extra.error).slice(0, 300) : null]);
    return u;
  };
  try {
    const { book, market } = await desk.context(plan.assetId, forecast.market);
    const built = orders.build({ asset_id: plan.assetId, side: 'BUY', order_type: 'FAK', amount_usd: String(amount), max_slippage_pct: 3 }, {
      book, platformFee: market.platform_fee, builder: env.polymarketBuilderCode, takerBps: env.polymarketTakerFeeBps, makerBps: env.polymarketMakerFeeBps,
      walletType: 'deposit', wallet: sess.wallet, signer: sess.wallet,
    });
    if (Number(built.summary.price) > plan.priceLimit) return finish('refused', { error: `The price is now ${built.summary.price}, past the forecast's limit of ${plan.priceLimit}: the edge is gone. Nothing was sent.` });
    // RektBull's key signs the Deposit Wallet's order; wrapped for the wallet, then in the session envelope.
    const signer = await sessionSigner();
    const td = built.typed_data;
    const { EIP712Domain, ...types } = td.types;
    const inner = await signer.signTypedData(td.domain, types, td.message);
    const signature = ethers.hexlify(orders.sessionEnvelope(env.polymarketSessionAddress, orders.wrapDepositWalletSignature(td, inner)));
    const c = await clobCredentials();
    const body = { ...built.body, owner: c.key, order: { ...built.body.order, signature } };
    const answer = await postOrder(body);
    if (!answer.success) return finish('failed', { error: `Polymarket refused it: ${answer.errorMsg || answer.error || 'no reason given'}` });
    // makingAmount: the pUSD paid for a BUY (six decimals), when Polymarket matched any of it.
    const filledUsd = answer.status === 'matched' ? Number(answer.makingAmount || 0) / 1e6 : 0;
    if (!(filledUsd > 0)) return finish('unfilled', { order_id: answer.orderID, filled_usd: 0 });
    const fee = feeFor(filledUsd, s);
    const paidFrom = await proposals.chargeCredits(sess.account_id, fee, `auto:${id}`, `Automated Polymarket buy: ${forecast.market}`);
    logger.info('automated Polymarket entry filled', { account: sess.account_id, filled_usd: filledUsd, fee });
    return finish('filled', { order_id: answer.orderID, filled_usd: filledUsd, fee_usd: fee, paid_from: paidFrom });
  } catch (err) {
    return finish('failed', { error: err.message });
  }
}

/** For a researched forecast: an automated entry for every active session that may trade. */
async function fromForecast(forecast, plan) {
  if (whyOff() || !fsettings().polymarket_auto) return 0;
  const { rows } = await db.query(`SELECT * FROM polymarket_sessions WHERE status = 'active'`);
  let filled = 0;
  for (const sess of rows) {
    const r = await place(sess, forecast, plan).catch(err => { logger.error('automated Polymarket entry failed', { error: err.message }); return null; });
    if (r?.status === 'filled') filled++;
  }
  return filled;
}

/** Ends sessions past their stop date (RektBull stops; the user can also end the key on Polymarket). */
async function tick() {
  await db.query(`UPDATE polymarket_sessions SET status = 'ended', ended_at = now() WHERE status = 'active' AND (stop_at <= now() OR valid_until * 1000 <= extract(epoch from now()) * 1000)`);
}

/** For the admin panel: whether it can run, and what it did in the last day. */
async function adminSummary() {
  const { rows: [a] } = await db.query(`SELECT COUNT(*)::int AS n FROM polymarket_sessions WHERE status = 'active'`);
  const { rows: [o] } = await db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(filled_usd), 0)::float AS usd, COALESCE(SUM(fee_usd), 0)::float AS fees
    FROM polymarket_auto_orders WHERE status = 'filled' AND created_at > now() - interval '24 hours'`);
  return { why_off: whyOff(), active: a.n, filled_24h: o.n, filled_usd_24h: Math.round(o.usd * 100) / 100, fees_usd_24h: Math.round(o.fees * 100) / 100 };
}

function publicConfig() { return { enabled: !whyOff(), session_signer: env.polymarketSessionAddress || null }; }

module.exports = {
  AutoRefused, disclosures, overview, start, stop, batchSettled, place, fromForecast, tick, publicConfig, adminSummary, feeFor, blockedReason,
  setSignerForTests, resetCredentials, MAX_STOP_DAYS,
};

/**
 * The relay for the Perps page: it passes an action that is ALREADY SIGNED on
 * to Hyperliquid. It exists so the rules below hold on the server, not only
 * in the page; it never signs, and it never receives a key (a signature can't
 * be turned back into one).
 *
 * What it will carry:
 *   - orders, cancels, leverage and isolated-margin changes, signed by the
 *     agent key that lives in the user's browser;
 *   - approveAgent and approveBuilderFee, signed by the user's own wallet,
 *     and only when that wallet is the one signed in here.
 * What it refuses, whatever is signed: withdrawals, transfers and every other
 * action. Deposits and withdrawals are made on Hyperliquid itself.
 *
 * Trigger orders (take-profit and stop-loss) must be reduce-only, so they can
 * close a position but never open one.
 *
 * The fee (docs/PAYMENTS.md): an order may name only RektBull's builder
 * address, at exactly RektBull's rate, and a fee approval is carried only for
 * that address and at most that rate. With no builder address set, orders
 * carry no builder field. An order that can only close (reduce-only) may go
 * without the fee, so a position can always be closed.
 * The one other rate is the proposal fee (HL_PROPOSAL_FEE_TENTHS_BPS): an
 * order may carry it only when the request names a live proposal of the
 * signed-in account's (hyperliquid/protect.js) and every order in it is
 * reduce-only, in that proposal's market. A fee approval may be for up to the
 * higher of the two rates; the user's own orders still carry the lower one.
 */
const env = require('../config/env');
const hl = require('../providers/hyperliquid');
const H = require('../../public/hl-core.js');

const L1 = ['order', 'cancel', 'cancelByCloid', 'updateLeverage', 'updateIsolatedMargin'];
const USER = ['approveAgent', 'approveBuilderFee'];
const MAX_ORDERS = 20;
const DAY = 86400000;

class RelayRefused extends Error {
  constructor(message, status = 400, code = 'bad_request') { super(message); this.status = status; this.code = code; }
}
const bad = m => { throw new RelayRefused(m); };

const isHex = (v, bytes) => typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes ? bytes * 2 : '1,64'}}$`).test(v);
const isAddr = v => isHex(v, 20);
const isNum = v => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0;
const only = (obj, keys, what) => { for (const k of Object.keys(obj)) if (!keys.includes(k)) bad(`${what} has a field RektBull doesn't relay: ${k}`); };

function checkOrder(o, i) {
  const what = `order ${i + 1}`;
  if (!o || typeof o !== 'object') bad(`${what} isn't an order`);
  only(o, ['a', 'b', 'p', 's', 'r', 't', 'c'], what);
  if (!Number.isInteger(o.a) || o.a < 0 || o.a >= 10000) bad(`${what}: a must be a perp market's index`); // 10000 and up are spot pairs
  if (typeof o.b !== 'boolean' || typeof o.r !== 'boolean') bad(`${what}: b and r must be true or false`);
  if (!isNum(o.p) || !isNum(o.s)) bad(`${what}: price and size must be positive numbers, as strings`);
  if (o.c !== undefined && !isHex(o.c, 16)) bad(`${what}: c must be a 16-byte hex id`);
  const t = o.t || {};
  if (t.limit && !t.trigger) {
    if (!H.TIFS.includes(t.limit.tif)) bad(`${what}: tif must be one of ${H.TIFS.join(', ')}`);
  } else if (t.trigger && !t.limit) {
    if (typeof t.trigger.isMarket !== 'boolean' || !isNum(t.trigger.triggerPx) || !['tp', 'sl'].includes(t.trigger.tpsl)) bad(`${what}: a trigger needs isMarket, triggerPx and tpsl (tp or sl)`);
    if (!o.r) throw new RelayRefused(`${what}: a take-profit or stop-loss must be reduce-only, so it can only close a position.`, 422, 'not_reduce_only');
  } else bad(`${what}: t must be a limit or a trigger`);
}

/** RektBull's builder code: { b: address, f: tenths of a basis point }, or null when no address is set. */
const builder = () => (env.hlBuilderAddress && env.hlBuilderFeeTenthsBps > 0 ? { b: env.hlBuilderAddress, f: env.hlBuilderFeeTenthsBps } : null);

/** The most a fee approval may be for: RektBull's fee, or its proposal fee when that's higher. */
const maxApproval = () => { const ours = builder(); return ours ? Math.max(ours.f, env.hlProposalFeeTenthsBps) : 0; };

function checkBuilder(action, opens, proposal) {
  const ours = builder();
  const b = action.builder;
  if (b !== undefined) {
    if (!b || typeof b !== 'object' || !isAddr(b.b) || !Number.isInteger(b.f)) bad('builder must be { b: address, f: tenths of a basis point }');
    if (!ours || b.b.toLowerCase() !== ours.b) throw new RelayRefused('This order names a builder that isn\'t RektBull\'s. RektBull only relays orders that pay its own builder address, or none.', 422, 'wrong_builder');
    if (b.f !== ours.f) {
      // The proposal fee, only on a live proposal's reduce-only orders in its market.
      const fits = proposal && b.f === proposal.fee_tenths_bps && action.orders.every(o => o.r === true && o.a === proposal.asset);
      if (!fits) throw new RelayRefused(`This order's fee (${H.feeRate(b.f)}) isn't RektBull's (${H.feeRate(ours.f)})${proposal ? ': a proposal\'s fee is only for its own reduce-only orders, in its market' : ''}.`, 422, 'wrong_fee');
    }
  } else if (ours && opens) {
    throw new RelayRefused(`Orders sent through RektBull carry its ${H.feeRate(ours.f)} fee on what fills. This one has no builder field.`, 422, 'builder_fee_missing');
  }
}

/**
 * Checks a signed request before it's passed on. wallet is the signed-in
 * account's EVM wallet. Returns what the request does:
 *   { type, opens, approves, payload }
 * opens: it can open or add to a position (an order that isn't reduce-only).
 * approves: it approves an agent or a builder fee.
 */
function check(body, { wallet, now = Date.now(), proposal = null }) {
  const { action, nonce, signature } = body || {};
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') bad('action is missing');
  if (!Number.isSafeInteger(nonce)) bad('nonce must be the time in milliseconds');
  // Hyperliquid accepts nonces from two days back to one day ahead.
  if (nonce < now - 2 * DAY || nonce > now + DAY) bad('nonce is too far from the current time');
  if (!signature || !isHex(signature.r) || !isHex(signature.s) || ![27, 28].includes(signature.v)) bad('signature must be { r, s, v }');
  if (body.vaultAddress) bad('RektBull doesn\'t relay actions for vaults or subaccounts');
  const payload = { action, nonce, signature: { r: signature.r, s: signature.s, v: signature.v } };

  if (USER.includes(action.type)) {
    if (action.hyperliquidChain !== (hl.isMainnet() ? 'Mainnet' : 'Testnet')) bad(`this is signed for ${action.hyperliquidChain}, and RektBull is on Hyperliquid ${hl.network()}`);
    if (!isHex(action.signatureChainId) || action.nonce !== nonce) bad('the action\'s nonce and signatureChainId don\'t match the request');
    if (action.type === 'approveAgent') {
      only(action, ['type', 'hyperliquidChain', 'signatureChainId', 'agentAddress', 'agentName', 'nonce'], 'approveAgent');
      if (!isAddr(action.agentAddress)) bad('agentAddress must be an address');
      if (typeof action.agentName !== 'string' || action.agentName.length > 64) bad('agentName must be a short name');
      const until = / valid_until (\d+)$/.exec(action.agentName);
      if (until && Number(until[1]) > now + H.MAX_AGENT_DAYS * DAY) bad(`an agent can be approved for at most ${H.MAX_AGENT_DAYS} days`);
    } else {
      only(action, ['type', 'hyperliquidChain', 'signatureChainId', 'maxFeeRate', 'builder', 'nonce'], 'approveBuilderFee');
      if (!isAddr(action.builder) || typeof action.maxFeeRate !== 'string' || !/^\d+(\.\d+)?%$/.test(action.maxFeeRate)) bad('approveBuilderFee needs a builder address and a maxFeeRate such as "0.01%"');
      const ours = builder();
      if (!ours) throw new RelayRefused('RektBull has no builder address set, so there is no fee to approve.', 422, 'no_builder');
      if (action.builder.toLowerCase() !== ours.b) throw new RelayRefused('RektBull only relays a fee approval for its own builder address.', 422, 'wrong_builder');
      // At most RektBull's rate (its proposal fee, when that's higher): never an approval for more. "0%" takes the approval away.
      if (Number(action.maxFeeRate.slice(0, -1)) * 1000 > maxApproval() + 1e-9) throw new RelayRefused(`RektBull's fee is ${H.feeRate(ours.f)}${maxApproval() > ours.f ? ` (${H.feeRate(maxApproval())} on orders from its proposals)` : ''}: it won't relay an approval for more (${action.maxFeeRate}).`, 422, 'fee_too_high');
    }
    let signer;
    try { signer = H.recoverUser(action, payload.signature); } catch { bad('the signature couldn\'t be read'); }
    if (signer !== String(wallet).toLowerCase()) throw new RelayRefused('This approval isn\'t signed by the wallet you\'re signed in with. Switch your wallet to that account and sign again.', 403, 'wrong_signer');
    return { type: action.type, opens: false, approves: true, payload };
  }

  if (!L1.includes(action.type)) {
    throw new RelayRefused(`RektBull only relays orders, cancels, leverage changes and the two approvals. It never relays "${action.type}": deposits, withdrawals and transfers are made on Hyperliquid itself, from your own wallet.`, 422, 'action_not_relayed');
  }
  if (body.expiresAfter !== undefined && body.expiresAfter !== null) {
    if (!Number.isSafeInteger(body.expiresAfter)) bad('expiresAfter must be a time in milliseconds');
    payload.expiresAfter = body.expiresAfter;
  }
  let opens = false;
  if (action.type === 'order') {
    only(action, ['type', 'orders', 'grouping', 'builder'], 'the order action');
    if (!Array.isArray(action.orders) || !action.orders.length || action.orders.length > MAX_ORDERS) bad(`orders must hold 1 to ${MAX_ORDERS} orders`);
    if (!['na', 'normalTpsl', 'positionTpsl'].includes(action.grouping)) bad('grouping must be na, normalTpsl or positionTpsl');
    action.orders.forEach(checkOrder);
    opens = action.orders.some(o => !o.r);
    checkBuilder(action, opens, proposal);
  } else if (action.type === 'cancel') {
    only(action, ['type', 'cancels'], 'the cancel action');
    if (!Array.isArray(action.cancels) || !action.cancels.length || action.cancels.length > MAX_ORDERS || action.cancels.some(c => !Number.isInteger(c?.a) || !Number.isSafeInteger(c?.o))) bad('cancels must hold 1 to 20 { a, o } pairs');
  } else if (action.type === 'cancelByCloid') {
    only(action, ['type', 'cancels'], 'the cancel action');
    if (!Array.isArray(action.cancels) || !action.cancels.length || action.cancels.length > MAX_ORDERS || action.cancels.some(c => !Number.isInteger(c?.asset) || !isHex(c?.cloid, 16))) bad('cancels must hold 1 to 20 { asset, cloid } pairs');
  } else if (action.type === 'updateLeverage') {
    only(action, ['type', 'asset', 'isCross', 'leverage'], 'updateLeverage');
    if (!Number.isInteger(action.asset) || typeof action.isCross !== 'boolean' || !Number.isInteger(action.leverage) || action.leverage < 1 || action.leverage > 100) bad('updateLeverage needs asset, isCross and a whole leverage from 1');
  } else {
    only(action, ['type', 'asset', 'isBuy', 'ntli'], 'updateIsolatedMargin');
    if (!Number.isInteger(action.asset) || typeof action.isBuy !== 'boolean' || !Number.isSafeInteger(action.ntli)) bad('updateIsolatedMargin needs asset, isBuy and ntli');
  }
  return { type: action.type, opens, approves: false, payload };
}

/** What Hyperliquid said, in a few words: each order's fill, resting id or refusal. */
function summarize(answer) {
  const statuses = answer?.response?.data?.statuses;
  if (!Array.isArray(statuses)) return null;
  return statuses.map(s => (s?.filled ? { filled: true, size: Number(s.filled.totalSz), avg_px: Number(s.filled.avgPx), oid: s.filled.oid }
    : s?.resting ? { resting: true, oid: s.resting.oid }
      : s?.error ? { error: String(s.error) } : { status: typeof s === 'string' ? s : JSON.stringify(s) }));
}

/** Checks and sends. Throws RelayRefused with Hyperliquid's own reason when it refuses the whole request. */
async function send(body, ctx) {
  if (!env.hlEnabled) throw new RelayRefused('Perps trading is switched off on this server for now (HL_ENABLED).', 503, 'not_enabled');
  const checked = check(body, ctx);
  if (ctx.before) await ctx.before(checked);
  const answer = await hl.exchange(checked.payload);
  if (answer?.status !== 'ok') {
    const reason = typeof answer?.response === 'string' ? answer.response : 'no reason given';
    throw new RelayRefused(`Hyperliquid refused it: ${reason}`, 422, 'hyperliquid_refused');
  }
  return { ok: true, type: checked.type, results: summarize(answer), hyperliquid: answer, source: 'Hyperliquid\'s exchange API' };
}

module.exports = { check, send, summarize, builder, maxApproval, RelayRefused, L1, USER };

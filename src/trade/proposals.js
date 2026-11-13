/**
 * Approve-each trades: RektBull proposes, the user's own wallet signs.
 *
 *   propose  -> every check runs on an indicative basis and the plan is shown;
 *   approve  -> every check runs again on a fresh firm quote (as in Soyjak:
 *               prices move), and the wallet calls are built;
 *   submit   -> the user's wallet sent them; the trade service confirms the
 *               transaction onchain and records the position.
 *
 * One click (Trade desk, stage 1) shortens the first two steps:
 *   preview  -> every check and a firm quote, stored nowhere: what the page
 *               shows as soon as a token is chosen;
 *   trade    -> every check runs again on a fresh quote and the wallet calls
 *               come back at once (an approved proposal). Given the preview
 *               the user saw, under 30 seconds old, the trade is refused if
 *               it would now get less than that preview's minimum: what the
 *               user was shown as the worst case still holds when they sign.
 *
 * Trading is only ever from the signed-in wallet: a session for one wallet
 * can't propose trades for another.
 */
const crypto = require('crypto');
const db = require('../config/db');
const rules = require('./rules');
const { walletCalls } = require('./calls');

const APPROVE_WINDOW_MINUTES = 30; // a proposal not approved by then expires
const PREVIEW_MAX_AGE_MS = 30 * 1000; // one click trades on a preview at most this old
const json = v => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

function present(row) {
  return {
    id: row.id, status: row.status, chain: row.chain, side: row.side, token: row.token, base: row.base,
    amount_usd: row.amount_usd === null ? null : Number(row.amount_usd),
    sell_fraction: row.sell_fraction === null ? null : Number(row.sell_fraction),
    plan: row.plan, calls: row.status === 'approved' ? row.calls : undefined,
    tx_hash: row.tx_hash, error: row.error,
    created_at: row.created_at, approved_at: row.approved_at, submitted_at: row.submitted_at, finished_at: row.finished_at,
  };
}

const planView = p => ({ summary: p.summary, checks: p.checks, value_usd: p.valueUsd });

const inputOf = (account, input) => ({
  accountId: account.id, wallet: account.wallet, chain: input.chain, side: input.side, token: input.token,
  base: input.base, amountUsd: input.amount_usd, sellFraction: input.sell_fraction, acknowledgeRisks: !!input.acknowledge_risks,
});

/**
 * Every check on a firm quote, for the page to show before the click. Nothing
 * is stored; `seen` is what to send back with the trade.
 */
async function preview(account, input) {
  const p = await rules.prepare(inputOf(account, input));
  const quotedAt = new Date().toISOString();
  return {
    chain: p.chain, side: p.side, token: p.token, base: p.base,
    plan: planView(p), quoted_at: quotedAt,
    seen: { chain: p.chain, side: p.side, token: p.token, base: p.base, sell_amount: p.summary.sell_amount, buy_amount: p.summary.buy_amount, min_buy_amount: p.summary.min_buy_amount, quoted_at: quotedAt },
  };
}

const digits = v => /^\d+$/.test(String(v ?? ''));

/** The preview a one-click trade was made on: checked for shape and age, or null if none was sent. */
function seenPreview(input) {
  const s = input.seen;
  if (s === undefined || s === null) return null;
  const quotedAt = Date.parse(s.quoted_at);
  if (!digits(s.sell_amount) || !digits(s.buy_amount) || !digits(s.min_buy_amount) || BigInt(s.sell_amount) === 0n || !Number.isFinite(quotedAt)) {
    throw Object.assign(new Error('seen must be the preview the trade was made on, as /v1/trading/preview returned it'), { status: 400 });
  }
  const same = String(s.chain) === String(input.chain) && String(s.side) === String(input.side) && String(s.token || '').toLowerCase() === String(input.token || '').toLowerCase();
  if (!same) throw Object.assign(new Error('seen is a preview of a different trade'), { status: 400 });
  if (Date.now() - quotedAt > PREVIEW_MAX_AGE_MS) {
    throw Object.assign(new Error('The price you saw is over 30 seconds old. Look at the new one, then click again.'), { status: 409, code: 'preview_stale' });
  }
  return { ...s, base: String(s.base || '').toUpperCase() };
}

/**
 * One click: every check on a fresh quote, and the wallet calls at once, as an
 * approved proposal. Refused if it would now get less, for what it spends, than
 * the minimum of the preview the user saw.
 */
async function trade(account, input) {
  const seen = seenPreview(input);
  const started = Date.now();
  const p = await rules.prepare({ ...inputOf(account, input), seen });
  const prepareMs = Date.now() - started;
  if (seen && seen.base === p.base) {
    // Compared as rates (what's received per unit spent), so a preview of another amount still counts.
    const now = BigInt(p.summary.buy_amount) * BigInt(seen.sell_amount);
    const worst = BigInt(seen.min_buy_amount) * BigInt(p.summary.sell_amount);
    if (now < worst) {
      throw Object.assign(new rules.TradeBlocked('The price moved past the worst case you were shown. Look at the new price, then click again.'), { code: 'price_moved' });
    }
  }
  const calls = walletCalls(p);
  const timing = { prepare_ms: prepareMs, previewed: !!seen };
  // The fee to offer the wallet, by the user's speed setting; a fee that couldn't be read leaves it to the wallet, saying why.
  const { send_speed: speed } = await rules.settingsFor(account.id);
  const fees = await require('./fees').suggest(p.chain, speed).catch(err => ({ speed, none: `The fee couldn't be read from ${p.chain} (${err.message}), so your wallet chooses it.` }));
  const { rows } = await db.query(
    `INSERT INTO trade_proposals (id, account_id, wallet, chain, side, token, base, amount_usd, sell_fraction, plan, calls, status, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'approved', now()) RETURNING *`,
    [crypto.randomUUID(), account.id, account.wallet, p.chain, p.side, p.token, p.base, p.side === 'buy' ? p.valueUsd : null, p.sellFraction || null,
      json({ ...planView(p), acknowledge_risks: !!input.acknowledge_risks, sell_amount: p.quote.sellAmount, expected_buy: p.quote.buyAmount, one_click: true, timing, fees }), json(calls)],
  );
  return { ...present(rows[0]), fees };
}

async function propose(account, input) {
  const p = await rules.prepare(inputOf(account, input));
  const id = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO trade_proposals (id, account_id, wallet, chain, side, token, base, amount_usd, sell_fraction, plan)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [id, account.id, account.wallet, p.chain, p.side, p.token, p.base, p.side === 'buy' ? p.valueUsd : null, p.sellFraction || null,
      json({ ...planView(p), acknowledge_risks: !!input.acknowledge_risks })],
  );
  return present(rows[0]);
}

async function load(account, id, client = db) {
  const { rows } = await client.query('SELECT * FROM trade_proposals WHERE id = $1 AND account_id = $2', [id, account.id]);
  if (!rows.length) throw Object.assign(new Error('trade proposal not found'), { status: 404 });
  return rows[0];
}

async function approve(account, id) {
  const row = await load(account, id);
  if (row.status !== 'proposed') throw Object.assign(new Error(`this proposal is ${row.status}`), { status: 409 });
  if (Date.now() - new Date(row.created_at).getTime() > APPROVE_WINDOW_MINUTES * 60 * 1000) {
    await db.query(`UPDATE trade_proposals SET status = 'expired', finished_at = now() WHERE id = $1`, [id]);
    throw Object.assign(new Error('this proposal has expired; propose the trade again'), { status: 409 });
  }
  let p;
  try {
    p = await rules.prepare({
      accountId: account.id, wallet: account.wallet, chain: row.chain, side: row.side, token: row.token, base: row.base,
      amountUsd: row.amount_usd, sellFraction: row.sell_fraction, acknowledgeRisks: !!row.plan?.acknowledge_risks,
    });
  } catch (err) {
    if (err.isTradeBlocked) await db.query(`UPDATE trade_proposals SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [id, `on approval: ${err.message}`]);
    throw err;
  }
  const calls = walletCalls(p);
  const { rows } = await db.query(
    `UPDATE trade_proposals SET status = 'approved', approved_at = now(), plan = $2, calls = $3 WHERE id = $1 AND status = 'proposed' RETURNING *`,
    [id, json({ ...planView(p), acknowledge_risks: !!row.plan?.acknowledge_risks, sell_amount: p.quote.sellAmount, expected_buy: p.quote.buyAmount }), json(calls)],
  );
  if (!rows.length) throw Object.assign(new Error('this proposal changed while it was being approved'), { status: 409 });
  return present(rows[0]);
}

/**
 * The user's wallet sent the trade. clickToPromptMs, from the page: how long from
 * the click until the wallet was asked to sign (kept on one-click trades).
 */
async function submitted(account, id, txHash, clickToPromptMs = null) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) throw Object.assign(new Error('tx_hash must be a transaction hash'), { status: 400 });
  const ms = Number(clickToPromptMs);
  const timed = clickToPromptMs !== null && clickToPromptMs !== undefined && Number.isFinite(ms) && ms >= 0 && ms <= 10 * 60 * 1000 ? Math.round(ms) : null;
  const { rows } = await db.query(
    `UPDATE trade_proposals SET status = 'submitted', tx_hash = $3, submitted_at = now(),
       plan = CASE WHEN $4::int IS NULL OR plan->'timing' IS NULL THEN plan ELSE jsonb_set(plan, '{timing,click_to_prompt_ms}', to_jsonb($4::int)) END
     WHERE id = $1 AND account_id = $2 AND status = 'approved' RETURNING *`,
    [id, account.id, txHash.toLowerCase(), timed],
  );
  if (!rows.length) throw Object.assign(new Error('only an approved proposal can be marked as sent'), { status: 409 });
  return present(rows[0]);
}

async function cancel(account, id) {
  const { rows } = await db.query(
    `UPDATE trade_proposals SET status = 'cancelled', finished_at = now() WHERE id = $1 AND account_id = $2 AND status IN ('proposed', 'approved') RETURNING *`,
    [id, account.id],
  );
  if (!rows.length) throw Object.assign(new Error('only a proposal that hasn\'t been sent can be cancelled'), { status: 409 });
  return present(rows[0]);
}

async function list(account) {
  const { rows } = await db.query('SELECT * FROM trade_proposals WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50', [account.id]);
  return rows.map(present);
}

const get = async (account, id) => present(await load(account, id));

module.exports = { preview, trade, propose, approve, submitted, cancel, list, get, PREVIEW_MAX_AGE_MS };

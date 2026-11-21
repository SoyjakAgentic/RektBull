/**
 * The Polymarket desk: orders prepared for the user's wallet to sign.
 *
 * RektBull builds the order (checked against the live book's tick size and
 * minimum, with RektBull's builder code in it) and hands back the EIP-712
 * payload. The user's wallet signs it, and the user's browser posts it to
 * Polymarket's CLOB with the user's own CLOB API credentials, which never
 * reach this server. The browser then tells RektBull what Polymarket
 * answered (an order id and status; nothing secret), for the user's history.
 *
 * No order is prepared without a builder code: the builder fee, charged by
 * Polymarket on fills only, is what the desk earns (docs/POLYMARKET.md).
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const db = require('../config/db');
const env = require('../config/env');
const pm = require('../providers/polymarket');
const markets = require('./markets');
const orders = require('./orders');
const wallets = require('./wallets');
const { CHAIN_ID, C, APPROVALS, WALLET_TYPES, exchangeFor } = require('./contracts');

const { OrderRefused } = orders;
const lower = a => String(a || '').toLowerCase();

/** Why the desk can't take orders right now, or null. */
function unavailable() {
  if (!env.polymarketEnabled) return 'Polymarket trading is switched off on this server (POLYMARKET_ENABLED).';
  if (!env.polymarketBuilderCode) return 'Polymarket trading isn\'t set up yet: RektBull\'s builder code is missing (POLYMARKET_BUILDER_CODE).';
  return null;
}

const builders = require('./builders');
const feeText = (b = builders.main()) => builders.feeText(b);
const feeHow = b => `RektBull's fee is a Polymarket builder fee: ${feeText(b)}. Polymarket charges it only on fills and pays it to RektBull's builder profile; an order that doesn't fill, or is cancelled, costs nothing. It is added to any fee Polymarket itself charges on the market.`;

/** What the page needs to know: public values only. */
function config() {
  const why = unavailable();
  return {
    enabled: !why, ...(why ? { unavailable: why } : {}),
    chain_id: CHAIN_ID, chain_id_hex: '0x' + CHAIN_ID.toString(16),
    clob_url: pm.CLOB, geoblock_url: 'https://polymarket.com/api/geoblock',
    builder_code: env.polymarketBuilderCode || null,
    fee: {
      taker_bps: env.polymarketTakerFeeBps, maker_bps: env.polymarketMakerFeeBps,
      how: feeHow(builders.main()),
      source: 'docs.polymarket.com/programs/builders/fees',
    },
    ai_fee: {
      taker_bps: builders.ai().takerBps, maker_bps: builders.ai().makerBps, separate_code: builders.ai().id === 'ai',
      how: `Orders from an AI proposal or an automatic entry carry RektBull's AI builder fee: ${feeText(builders.ai())}, charged by Polymarket on fills only. RektBull's AI fee comes on top, from AI credits: $${require('../forecasts/settings').get().proposal_usd} when you act on a proposal; for automatic entries, ${require('../forecasts/settings').get().auto_fee_pct}% of what fills, at least $${require('../forecasts/settings').get().auto_fee_min_usd}.`,
    },
    wallet_types: Object.fromEntries(Object.entries(WALLET_TYPES).map(([k, v]) => [k, { label: v.label, about: v.about, signature_type: v.signature_type }])),
    contracts: C,
    approvals: APPROVALS.map(a => ({ id: a.id, token: a.token_name, to: a.spender_name, what: a.what })),
    relayer_ready: pm.builderConfigured(),
    automatic: require('./auto').publicConfig(),
    order_types: { GTC: 'Limit: stays open until it fills or you cancel it', GTD: 'Limit: stays open until a time you set', FAK: 'Market: fills what it can now, cancels the rest', FOK: 'Market: fills completely now, or not at all' },
  };
}

/** The outcome's book and its market's facts, for an order. */
async function context(assetId, marketSlug) {
  const book = markets.presentBook(await pm.book(assetId));
  const raw = marketSlug ? await pm.market(marketSlug) : null;
  if (!raw) throw new OrderRefused('market_slug is needed, and Polymarket must know it: RektBull reads the market\'s fees and status before preparing an order.');
  const m = markets.presentMarket(raw);
  const outcome = m.outcomes.find(o => o.asset_id === String(assetId));
  if (!outcome) throw new OrderRefused('That outcome isn\'t part of that market.');
  if (!m.accepting_orders) throw new OrderRefused(m.closed ? 'This market is closed.' : 'This market isn\'t accepting orders right now.', 'market_closed');
  return { book, market: m, outcome };
}

/**
 * Prepares one order for the account's wallet to sign. `source` is 'user', or 'rule' for a proposal being signed.
 */
async function prepare(account, input = {}, { source = 'user', ruleId = null } = {}) {
  const why = unavailable();
  if (why) throw Object.assign(new OrderRefused(why, 'not_available'), { status: 503 });
  if (!/^[0-9]{1,80}$/.test(String(input.asset_id || ''))) throw new OrderRefused('asset_id must be the outcome\'s numeric id');
  const w = await wallets.resolve(account, { walletType: input.wallet_type, address: input.address });
  const { book, market, outcome } = await context(input.asset_id, input.market_slug);
  // An order from an approved AI proposal carries the AI builder code, and never pays more than the proposal's limit.
  const proposal = input.proposal_id ? await require('../forecasts/proposals').forOrder(account.id, input.proposal_id, input) : null;
  if (proposal) { source = 'rule'; ruleId = proposal.id; }
  const b = proposal ? builders.ai() : builders.main();
  const built = orders.build(input, {
    book, platformFee: market.platform_fee, builder: b.code, takerBps: b.takerBps, makerBps: b.makerBps,
    walletType: w.wallet_type, wallet: w.wallet, signer: w.signer,
  });
  if (proposal && Number(built.summary.price) > Number(proposal.price_limit)) throw new OrderRefused(`That would pay up to ${built.summary.price}, more than the proposal's limit of ${Number(proposal.price_limit)}: the AI's edge would be gone. Use a limit price at or under it.`, 'past_proposal_limit');
  const orderHash = ethers.TypedDataEncoder.hash({ name: 'Polymarket CTF Exchange', ...exchangeFor(book), chainId: CHAIN_ID }, { Order: orders.TYPES.Order }, built.order);
  const id = crypto.randomUUID();
  const s = built.summary;
  const prepared = { typed_data: built.typed_data, signature_suffix: built.signature_suffix, body: built.body, summary: s };
  await db.query(
    `INSERT INTO polymarket_orders (id, account_id, wallet, signer, wallet_type, asset_id, condition_id, market_slug, title, outcome, side, order_type, price, shares, notional_usd, builder, order_hash, source, rule_id, prepared)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [id, account.id, lower(w.wallet), lower(w.signer), w.wallet_type, String(input.asset_id), market.condition_id, market.slug, market.question, outcome.name, s.side, s.order_type, s.price, s.shares, s.notional_usd, b.code, orderHash, source, ruleId, JSON.stringify(prepared)],
  );
  return {
    id, wallet: w.wallet, signer: w.signer, wallet_type: w.wallet_type, market: { slug: market.slug, question: market.question, outcome: outcome.name },
    ...prepared,
    send: { method: 'POST', url: pm.CLOB + '/order', path: '/order', note: 'Sent from your browser with your own Polymarket API credentials; RektBull\'s server never sees them or your signature.' },
    fee: { ...s.fees, how: feeHow(b), ...(proposal ? { ai: true } : {}) },
    book: { best_bid: book.best_bid, best_ask: book.best_ask, tick_size: book.tick_size, min_order_size: book.min_order_size, source: book.source, read_at: book.read_at },
    resolution: market.resolution,
    not_advice: 'RektBull prepared this order from what you entered. It never picks an outcome, and a prediction market can lose everything you put in.',
  };
}

const present = r => ({
  id: r.id, wallet: r.wallet, wallet_type: r.wallet_type, market_slug: r.market_slug, title: r.title, outcome: r.outcome, side: r.side, order_type: r.order_type,
  price: Number(r.price), shares: Number(r.shares), notional_usd: Number(r.notional_usd), source: r.source, status: r.status,
  clob_order_id: r.clob_order_id, clob_status: r.clob_status, error: r.error, created_at: r.created_at,
});

async function load(account, id) {
  const { rows: [r] } = /^[0-9a-f-]{36}$/.test(String(id)) ? await db.query('SELECT * FROM polymarket_orders WHERE id = $1 AND account_id = $2', [id, account.id]) : { rows: [] };
  if (!r) throw Object.assign(new Error('No such order.'), { status: 404 });
  return r;
}

/** What Polymarket answered when the browser sent the order: its id and status, or its reason for refusing it. */
async function result(account, id, body = {}) {
  const r = await load(account, id);
  if (r.status !== 'prepared') return present(r);
  const ok = body.success === true && /^0x[0-9a-fA-F]{64}$/.test(String(body.order_id || ''));
  const status = ['live', 'matched', 'delayed', 'unmatched'].includes(body.status) ? body.status : null;
  const { rows: [u] } = await db.query(
    'UPDATE polymarket_orders SET status = $2, clob_order_id = $3, clob_status = $4, error = $5, finished_at = now() WHERE id = $1 RETURNING *',
    [id, ok ? 'submitted' : 'rejected', ok ? String(body.order_id).toLowerCase() : null, ok ? status : null, ok ? null : String(body.error || 'Polymarket did not accept the order').slice(0, 300)],
  );
  return present(u);
}

/** The user cancelled this order on Polymarket (from the browser), or dropped it before signing. */
async function cancelled(account, id) {
  const r = await load(account, id);
  if (!['prepared', 'proposed', 'submitted'].includes(r.status)) return present(r);
  const { rows: [u] } = await db.query('UPDATE polymarket_orders SET status = $2, finished_at = now() WHERE id = $1 RETURNING *', [id, 'cancelled']);
  return present(u);
}

async function list(account) {
  const { rows } = await db.query('SELECT * FROM polymarket_orders WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50', [account.id]);
  return rows.map(present);
}

module.exports = { config, unavailable, prepare, result, cancelled, list, present, load, context, feeText };

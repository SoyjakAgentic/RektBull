/**
 * The wallet tracker (Trade desk, stage 3): follow any wallets, and get an
 * alert within seconds when one buys or sells a token, with RektBull's token
 * check (and, for a token under a week old, the bundle check) already run and
 * the buy ready on the Trade desk for your own wallet to sign.
 *
 * How a trade is seen, on Base, Ethereum, Arbitrum and BNB Chain: every few
 * seconds, two eth_getLogs per chain ask for the ERC-20 Transfer events from
 * and to any followed wallet in the blocks since the last read (wallets in
 * groups of 100, everyone's in the same calls). Those queries name no contract,
 * so they go to your own RPC_URLS_<CHAIN> first, then keyless endpoints that
 * answer them (providers/chains.js TOPIC_LOGS_RPC). Per transaction and wallet:
 *
 *   - it received a token and gave something in the same transaction: a swap,
 *     so a buy of what came in (and a sale of what went out);
 *   - it only received a token: a buy only if the wallet sent the transaction
 *     itself and paid ETH or BNB with it (an airdrop or a transfer from someone
 *     else is not a trade);
 *   - it only sent a token: a sale only if the wallet sent the transaction and
 *     ETH or BNB came back, which its receipt shows (the router unwrapping WETH
 *     or WBNB, with the amount, or four.meme's curve paying out); otherwise it
 *     was a transfer, a deposit or a repayment;
 *   - ETH, WETH, BNB, WBNB, stablecoins and VIRTUAL are what trades are paid
 *     in, not what is traded; a token minted to the wallet or burnt from it
 *     (pool or vault shares, a loan's debt token, an LP token) means it isn't
 *     a trade.
 *
 * Limits of reading logs: a trade paid in ETH from a smart-contract wallet
 * (sent by a bundler) isn't seen, nor a sale into a pool that pays native ETH
 * without WETH (some Uniswap v4 pools); what a four.meme curve sale received
 * isn't in its logs (its value is worked out from the token's price, when
 * there is one).
 * If the tracker falls more than about two minutes behind, it starts again from
 * the newest block: a late alert isn't a signal any more.
 *
 * Solana addresses are recognised and stored the same way (migration 025),
 * but followed only once RektBull trades on Solana.
 */
const { ethers } = require('ethers');
const db = require('../config/db');
const logger = require('../config/logger');
const rpc = require('../providers/rpc');
const prices = require('../providers/prices');
const { cached } = require('../lib/cache');
const passes = require('../payments/passes');
const { SAFETY_PRO } = require('../payments/catalog');
const { TRADE_CHAINS } = require('../trade/chains');
const agentStates = require('../admin/agentStates');

class TrackerRefused extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const FREE_WALLETS = 5;
const PRO_WALLETS = SAFETY_PRO.follow.wallets;
const CHAINS = ['base', 'ethereum', 'arbitrum', 'bsc'];
// Further behind than two minutes, the read starts again from the newest block: a late alert isn't a signal.
const MAX_BEHIND_S = 120;
const WALLETS_PER_CALL = 100;
const CHECK_MS = 8000; // the token and bundle checks an alert carries; past this it says they run on the Trade desk
const ALERTS_PER_TICK = 20; // a wallet trading in bursts: the rest are recorded and shown, not alerted
const KEEP_DAYS = 35;
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const ERC20 = new ethers.Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

/** What trades are paid in on each chain: never reported as the thing traded. */
const QUOTE = {
  base: { '0x4200000000000000000000000000000000000006': 'WETH', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC', '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC', '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 'USDT', '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI', '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': 'VIRTUAL' },
  ethereum: { '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC', '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT', '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI' },
  arbitrum: { '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'WETH', '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC', '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC.e', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'USDT', '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 'DAI' },
  bsc: { '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'WBNB', '0x55d398326f99059ff775485246999027b3197955': 'USDT', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC', '0xe9e7cea3dedca5984780bafc599bd69add087d56': 'BUSD' },
};
const NATIVE = { base: { symbol: 'ETH', wrapped: '0x4200000000000000000000000000000000000006' }, ethereum: { symbol: 'ETH', wrapped: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' }, arbitrum: { symbol: 'ETH', wrapped: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' }, bsc: { symbol: 'BNB', wrapped: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' } };

const lower = a => String(a || '').toLowerCase();
const short = a => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const pad32 = a => '0x' + lower(a).slice(2).padStart(64, '0');
const unpad = t => '0x' + String(t).slice(-40).toLowerCase();
const within = (p, ms, what) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} seconds`)), ms).unref())]);

/* ── following ── */

/** { address, family } from what the user typed; a Solana address is recognised and stored as given. */
function parseAddress(input) {
  const s = String(input || '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { address: s.toLowerCase(), family: 'evm' };
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return { address: s, family: 'solana' };
  throw new TrackerRefused('That isn\'t a wallet address (0x and 40 hex characters).');
}

async function limitFor(accountId) {
  const pro = await passes.covering(accountId, 'risk_monitor');
  return { pro: !!pro, limit: pro ? PRO_WALLETS : FREE_WALLETS };
}

async function follow(accountId, { address, label } = {}) {
  const w = parseAddress(address);
  if (w.family === 'solana') throw new TrackerRefused('Following Solana wallets comes with RektBull\'s Solana trading, which isn\'t here yet. Wallets on Base, Ethereum, Arbitrum and BNB Chain (0x…) can be followed now.');
  const { pro, limit } = await limitFor(accountId);
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM followed_wallets WHERE account_id = $1 AND address <> $2', [accountId, w.address]);
  if (n >= limit) {
    if (!pro) throw new TrackerRefused(`You can follow up to ${FREE_WALLETS} wallets for free, and ${PRO_WALLETS} with Safety Pro. Stop following one first, or get Safety Pro.`, 402, { offer: 'pro_30d' });
    throw new TrackerRefused(`Safety Pro follows up to ${PRO_WALLETS} wallets; stop following one first.`, 409);
  }
  await db.query(
    `INSERT INTO followed_wallets (account_id, address, family, label) VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, address) DO UPDATE SET label = COALESCE(EXCLUDED.label, followed_wallets.label)`,
    [accountId, w.address, w.family, label ? String(label).trim().slice(0, 40) || null : null],
  );
  return list(accountId);
}

async function unfollow(accountId, id) {
  const { rowCount } = await db.query('DELETE FROM followed_wallets WHERE id = $1 AND account_id = $2', [Number(id) || 0, accountId]);
  if (!rowCount) throw new TrackerRefused('not found', 404);
  return list(accountId);
}

const tradeLink = (chain, token) => `/trade?chain=${chain}&token=${token}&side=buy#trade-card`;
const tokenLink = (chain, token) => `/token?chain=${chain}&token=${token}`;

function presentTrade(t, label) {
  return {
    chain: t.chain, chain_name: TRADE_CHAINS[t.chain]?.label || t.chain, wallet: t.wallet, label: label || null, side: t.side, token: t.token, symbol: t.symbol,
    amount: t.amount === null ? null : Number(t.amount), other: t.other, usd: t.usd === null ? null : Number(t.usd), tx: t.tx_hash,
    tx_url: TRADE_CHAINS[t.chain]?.explorerTx(t.tx_hash) || null, at: t.seen_at, buy: tradeLink(t.chain, t.token), page: tokenLink(t.chain, t.token),
  };
}

/** The wallets this account follows, and their latest trades since it followed them. */
async function list(accountId) {
  const [{ pro, limit }, wallets] = await Promise.all([
    limitFor(accountId),
    db.query('SELECT id, address, family, label, created_at FROM followed_wallets WHERE account_id = $1 ORDER BY created_at', [accountId]),
  ]);
  const { rows: trades } = await db.query(
    `SELECT t.*, f.label FROM wallet_trades t JOIN followed_wallets f ON f.address = t.wallet AND f.account_id = $1
     WHERE t.seen_at >= f.created_at ORDER BY t.seen_at DESC, t.id DESC LIMIT 50`, [accountId]);
  const on = await require('./myAgents').isOn(accountId, 'wallet_tracker');
  return {
    wallets: wallets.rows, limit, free_limit: FREE_WALLETS, pro_limit: PRO_WALLETS, safety_pro: pro, alerts_on: on,
    chains: CHAINS.map(c => TRADE_CHAINS[c].label),
    trades: trades.map(t => presentTrade(t, t.label)),
    source: 'Token transfers read from each chain every few seconds (ERC-20 Transfer events); a check that couldn\'t run says why',
    note: 'A wallet\'s trades are information, not advice. Wallets that did well before can lose everything on the next trade, and some wallets trade to be copied.',
  };
}

/* ── reading the chains ── */

/** A token's symbol and decimals, read from its contract (a day). */
async function tokenMeta(chain, token) {
  if (QUOTE[chain]?.[token] && /^(USDC|USDbC|USDC\.e|USDT)$/.test(QUOTE[chain][token]) && chain !== 'bsc') return { symbol: QUOTE[chain][token], decimals: 6 };
  return cached(`tracker:meta:${chain}:${token}`, 86400, async () => {
    const call = async fn => ERC20.decodeFunctionResult(fn, await rpc.evmRpc(chain, 'eth_call', [{ to: token, data: ERC20.encodeFunctionData(fn) }, 'latest']))[0];
    const [symbol, decimals] = await Promise.all([call('symbol').catch(() => null), call('decimals').catch(() => null)]);
    return { symbol: symbol ? String(symbol).slice(0, 20) : null, decimals: decimals === null ? null : Number(decimals) };
  });
}

/** The Transfer logs from or to any of the wallets, in blocks from..to. */
async function transferLogs(chain, wallets, from, to) {
  const range = { fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) };
  const seen = new Map();
  for (let i = 0; i < wallets.length; i += WALLETS_PER_CALL) {
    const group = wallets.slice(i, i + WALLETS_PER_CALL).map(pad32);
    // One after the other: keyless endpoints rate-limit bursts.
    const out = await rpc.evmTopicLogs(chain, { ...range, topics: [TRANSFER, group] });
    const inn = await rpc.evmTopicLogs(chain, { ...range, topics: [TRANSFER, null, group] });
    for (const l of [...out, ...inn]) seen.set(`${l.transactionHash}:${Number(l.logIndex)}`, l);
  }
  return [...seen.values()];
}

const ZERO = '0x0000000000000000000000000000000000000000';
const WITHDRAWAL = ethers.id('Withdrawal(address,uint256)'); // WETH / WBNB unwrapped
const FOURMEME_MANAGER = '0x5c952063c7fc8610ffdb798152d69f0b9550762b'; // four.meme's curve pays BNB out itself

/**
 * The buys and sells in a set of Transfer logs, for the followed wallets.
 * When the logs alone can't tell a trade from something else, txOf(hash)
 * gives the transaction ({ from, to, value }) and receiptOf(hash) its receipt.
 */
async function tradesIn(chain, logs, walletSet, txOf, receiptOf) {
  const quote = QUOTE[chain] || {};
  const byTx = new Map();
  for (const l of logs) {
    // ERC-20 only: three topics and a 32-byte amount (ERC-721 puts its token id in a fourth topic).
    if (!l.topics || l.topics.length !== 3 || String(l.data || '').length !== 66) continue;
    const token = lower(l.address); const from = unpad(l.topics[1]); const to = unpad(l.topics[2]); const amount = BigInt(l.data);
    for (const [wallet, sign] of [[from, -1n], [to, 1n]]) {
      if (!walletSet.has(wallet) || from === to) continue;
      const key = `${l.transactionHash}|${wallet}`;
      if (!byTx.has(key)) byTx.set(key, { tx: l.transactionHash, block: Number(l.blockNumber), wallet, net: new Map(), burnt: false, minted: new Set() });
      const e = byTx.get(key);
      e.net.set(token, (e.net.get(token) || 0n) + sign * amount);
      if (sign < 0n && (to === token || to === ZERO)) e.burnt = true; // burnt (an LP token when liquidity comes out, a debt token repaid): not a sale
      if (sign > 0n && from === ZERO) e.minted.add(token); // minted to it (vault or pool shares, a loan's debt token): not a buy
    }
  }
  const trades = [];
  for (const e of byTx.values()) {
    if (e.burnt || e.minted.size) continue; // liquidity added or removed, a deposit, a loan or a repayment
    const moves = [...e.net].filter(([, v]) => v !== 0n);
    const got = moves.filter(([t, v]) => v > 0n && !quote[t]);
    const gave = moves.filter(([t, v]) => v < 0n && !quote[t]);
    if (!got.length && !gave.length) continue;
    const qIn = moves.find(([t, v]) => v > 0n && quote[t]);
    const qOut = moves.find(([t, v]) => v < 0n && quote[t]);
    const hasIn = moves.some(([, v]) => v > 0n); const hasOut = moves.some(([, v]) => v < 0n);
    let native = null;
    if (!hasOut) {
      // Only received: a buy only if the wallet sent the transaction and paid ETH or BNB with it.
      const tx = await txOf(e.tx).catch(() => null);
      if (!tx || lower(tx.from) !== e.wallet) continue; // an airdrop, a transfer in, or someone else's call
      const value = BigInt(tx.value || 0);
      if (value === 0n) continue; // nothing paid: a claim, not a buy
      native = { native: true, amount: value };
    } else if (!hasIn) {
      // Only sent: a sale only if ETH or BNB came back, which the receipt shows (the router unwrapping
      // WETH or WBNB, or four.meme's curve paying out). Otherwise it's a transfer, a deposit or a repayment.
      const r = await receiptOf(e.tx).catch(() => null);
      if (!r || lower(r.from) !== e.wallet || gave.some(([t]) => t === lower(r.to))) continue;
      const unwrapped = (r.logs || []).filter(l => lower(l.address) === NATIVE[chain].wrapped && l.topics?.[0] === WITHDRAWAL);
      const curve = chain === 'bsc' && (r.logs || []).some(l => lower(l.address) === FOURMEME_MANAGER);
      if (!unwrapped.length && !curve) continue;
      native = { native: true, amount: unwrapped.length ? BigInt(unwrapped[unwrapped.length - 1].data) : null };
    }
    const leg = q => (q ? { token: q[0], amount: q[1] < 0n ? -q[1] : q[1] } : null);
    for (const [token, v] of got) trades.push({ chain, tx: e.tx, block: e.block, wallet: e.wallet, side: 'buy', token, amount: v, other: leg(qOut) || leg(gave[0]) || native || { native: true, amount: null } });
    for (const [token, v] of gave) trades.push({ chain, tx: e.tx, block: e.block, wallet: e.wallet, side: 'sell', token, amount: -v, other: leg(qIn) || leg(got[0]) || native || { native: true, amount: null } });
  }
  return trades;
}

const fmt = (raw, decimals) => (raw === null || decimals === null || decimals === undefined ? null : Number(ethers.formatUnits(raw, decimals)));

/** A trade made readable: amounts in whole tokens, symbols, and about how much it was worth. */
async function describe(t) {
  const meta = await tokenMeta(t.chain, t.token).catch(() => ({ symbol: null, decimals: null }));
  let other;
  if (t.other.native) other = { native: true, symbol: NATIVE[t.chain].symbol, amount: fmt(t.other.amount, 18) };
  else {
    const m = await tokenMeta(t.chain, t.other.token).catch(() => ({ symbol: null, decimals: null }));
    other = { token: t.other.token, symbol: m.symbol || QUOTE[t.chain]?.[t.other.token] || null, amount: fmt(t.other.amount, m.decimals) };
  }
  const amount = fmt(t.amount, meta.decimals);
  // Worth: from what was paid or received when that's priced (ETH, a stablecoin), else from the token's own price.
  let usd = null;
  try {
    const otherId = other.native ? `${t.chain}:${NATIVE[t.chain].wrapped}` : `${t.chain}:${other.token}`;
    const tokenId = `${t.chain}:${t.token}`;
    const p = await within(prices.usdPrices([otherId, tokenId]), 5000, 'DefiLlama');
    if (other.amount !== null && p[otherId]) usd = other.amount * p[otherId];
    else if (amount !== null && p[tokenId]) usd = amount * p[tokenId];
  } catch { /* not priced: shown without a dollar value */ }
  return { ...t, symbol: meta.symbol, amount_whole: amount, other, usd: usd === null ? null : Math.round(usd * 100) / 100 };
}

/* ── alerts ── */

const scan = (chain, token) => cached(`tracker:scan:${chain}:${token}`, 300, () => require('./tokenRisk').scanToken({ chain, token_address: token }));

/** The checks a buy alert carries, each with its source; one that didn't run says why. */
async function checksFor(chain, token) {
  const [s, b] = await Promise.allSettled([
    within(scan(chain, token), CHECK_MS, 'the token check'),
    within(require('./launches').forTrade({ chain, token }), CHECK_MS, 'the bundle check'),
  ]);
  const reasons = [];
  let verdict = null;
  if (s.status === 'fulfilled' && !s.value.error) {
    verdict = s.value.verdict;
    const worst = s.value.flags.find(f => f.severity !== 'info');
    reasons.push({ text: `RektBull's token check: ${verdict}${worst ? `. ${worst.title}` : ''}`, source: worst?.source || 'RektBull token check (0x, GoPlus, verified source)' });
  } else {
    reasons.push({ text: `RektBull's token check didn't run here (${s.status === 'fulfilled' ? s.value.error : s.reason.message}); it runs again before any buy on the Trade desk`, source: 'RektBull' });
  }
  if (b.status === 'fulfilled') {
    if (b.value.young) reasons.push({ text: `Bundle check (a token under a week old): ${b.value.risk === 'unknown' ? b.value.detail : b.value.detail || b.value.risk}`, source: 'Launch Safety (early buyers\' funding, read from the chain and its explorer)' });
  } else {
    reasons.push({ text: `The bundle check didn't run here (${b.reason.message}); it runs before any buy of a young token on the Trade desk`, source: 'Launch Safety' });
  }
  return { verdict, bundle: b.status === 'fulfilled' ? b.value.risk : 'unknown', reasons };
}

const money = n => (n === null || n === undefined ? null : n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);
const num = n => (n === null ? 'an amount it couldn\'t read' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? Math.round(n).toLocaleString('en-US') : String(Number(n.toPrecision(4))));

/** The alert for one trade, for one follower. */
function alertFor(d, label, checks) {
  const who = label || short(d.wallet);
  const sym = d.symbol || short(d.token);
  const chainName = TRADE_CHAINS[d.chain].label;
  const verb = d.side === 'buy' ? 'bought' : 'sold';
  const otherText = d.other.amount === null ? (d.other.native ? `for ${d.other.symbol}` : '') : `${d.side === 'buy' ? 'for' : 'for'} ${num(d.other.amount)} ${d.other.symbol || short(d.other.token)}`;
  const worth = money(d.usd);
  const reasons = [
    { text: `${who} ${verb} ${num(d.amount_whole)} ${sym} ${otherText}${worth ? ` (about ${worth})` : ''}`.replace(/\s+/g, ' ').trim(), source: `transaction ${short(d.tx)} on ${chainName}, read from the chain` },
    ...(checks ? checks.reasons : []),
  ];
  return {
    wallet: d.wallet, kind: 'wallet_trade',
    severity: d.side === 'buy' && checks?.verdict === 'critical' ? 'high' : 'medium',
    title: `${who} ${verb} ${sym} on ${chainName}${d.side === 'buy' && checks?.verdict === 'critical' ? ' (token check: critical)' : ''}`,
    detail: {
      reasons, side: d.side, label: label || null,
      token: { chain: d.chain, token: d.token, symbol: d.symbol }, amount: d.amount_whole, other: d.other, usd: d.usd,
      tx: d.tx, tx_url: TRADE_CHAINS[d.chain].explorerTx(d.tx),
      link: d.side === 'buy' ? tradeLink(d.chain, d.token) : tokenLink(d.chain, d.token),
      ...(checks ? { checks: { verdict: checks.verdict, bundle: checks.bundle } } : {}),
    },
    dedupe: `wt:${d.chain}:${d.tx}:${d.wallet}:${d.token}:${d.side}`,
  };
}

/* ── the loop ── */

/** The EVM wallets someone follows with the tracker's alerts on. */
async function walletsWatched() {
  const { rows } = await db.query(
    `SELECT DISTINCT f.address FROM followed_wallets f
     LEFT JOIN agent_settings s ON s.account_id = f.account_id AND s.agent = 'wallet_tracker'
     WHERE f.family = 'evm' AND COALESCE(s.enabled, true)`);
  return rows.map(r => r.address);
}

async function followersOf(address) {
  const { rows } = await db.query(
    `SELECT f.account_id, f.label FROM followed_wallets f
     LEFT JOIN agent_settings s ON s.account_id = f.account_id AND s.agent = 'wallet_tracker'
     WHERE f.address = $1 AND COALESCE(s.enabled, true)`, [address]);
  return rows;
}

/** Seconds per block on a chain, measured over its last 1,000 blocks (an hour). Base is now ~0.2 s. */
function secondsPerBlock(chain, head) {
  return cached(`tracker:pace:${chain}`, 3600, async () => {
    const [a, b] = await Promise.all([head, head - 1000].map(n => rpc.evmRpc(chain, 'eth_getBlockByNumber', ['0x' + n.toString(16), false])));
    return Math.max(0.05, (Number(a.timestamp) - Number(b.timestamp)) / 1000);
  });
}

/** Runs fn over items, n at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

/** Reads one chain from where it was left, records the trades, and raises the alerts. */
async function tickChain(chain, wallets, budget) {
  const head = Number(await rpc.evmRpc(chain, 'eth_blockNumber', []));
  const { rows: [cur] } = await db.query('SELECT block FROM wallet_tracker_cursors WHERE chain = $1', [chain]);
  let from = cur ? Number(cur.block) + 1 : head;
  if (from > head) return { chain, blocks: 0, trades: 0 };
  if (head - from > 50) {
    const maxBehind = Math.ceil(MAX_BEHIND_S / await secondsPerBlock(chain, head));
    if (head - from > maxBehind) {
      logger.warn('wallet tracker: behind, starting again from the newest block', { chain, skipped: head - from });
      from = head;
    }
  }
  const logs = await transferLogs(chain, wallets, from, head);
  const txOf = hash => cached(`tracker:tx:${chain}:${hash}`, 600, () => rpc.evmRpc(chain, 'eth_getTransactionByHash', [hash]));
  const receiptOf = hash => cached(`tracker:receipt:${chain}:${hash}`, 600, () => rpc.evmRpc(chain, 'eth_getTransactionReceipt', [hash]));
  const found = await module.exports.tradesIn(chain, logs, new Set(wallets), txOf, receiptOf);

  // Recorded first (a trade seen before is skipped), then the checks for the new buys, each token once and
  // several at a time, so one slow check doesn't hold up the rest; then one alert per follower.
  const fresh = [];
  for (const d of await pool(found, 4, describe)) {
    const { rows } = await db.query(
      `INSERT INTO wallet_trades (chain, wallet, tx_hash, block, side, token, symbol, amount, other, usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (chain, tx_hash, wallet, token, side) DO NOTHING RETURNING id`,
      [chain, d.wallet, d.tx, d.block, d.side, d.token, d.symbol, d.amount_whole, JSON.stringify(d.other), d.usd]);
    if (rows.length) fresh.push(d);
  }
  const toAlert = fresh.slice(0, Math.max(0, budget.left));
  budget.left -= toAlert.length;
  if (fresh.length > toAlert.length) logger.warn('wallet tracker: too many trades at once; recorded, not alerted', { chain, not_alerted: fresh.length - toAlert.length });
  const buys = [...new Set(toAlert.filter(d => d.side === 'buy').map(d => d.token))];
  const checks = Object.fromEntries(await pool(buys, 4, async token => [token, await checksFor(chain, token)]));
  for (const d of toAlert) {
    for (const f of await followersOf(d.wallet)) await require('./myAgents').raise(f.account_id, [alertFor(d, f.label, checks[d.token] || null)]);
  }
  await db.query(
    `INSERT INTO wallet_tracker_cursors (chain, block, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (chain) DO UPDATE SET block = EXCLUDED.block, updated_at = now()`, [chain, head]);
  return { chain, blocks: head - from + 1, trades: fresh.length };
}

/** One pass over every chain (the worker runs it every few seconds). */
async function tick() {
  if (agentStates.isOff('wallet_tracker')) return [];
  const wallets = await walletsWatched();
  if (!wallets.length) return [];
  const budget = { left: ALERTS_PER_TICK };
  const out = await Promise.allSettled(CHAINS.map(c => tickChain(c, wallets, budget)));
  return out.map((r, i) => {
    if (r.status === 'rejected') logger.warn('wallet tracker: a chain couldn\'t be read', { chain: CHAINS[i], error: r.reason.message });
    return r.status === 'fulfilled' ? r.value : { chain: CHAINS[i], error: r.reason.message };
  });
}

module.exports = {
  follow, unfollow, list, tick, tickChain, tradesIn, describe, alertFor, checksFor, parseAddress, transferLogs,
  TrackerRefused, CHAINS, QUOTE, FREE_WALLETS, PRO_WALLETS, MAX_BEHIND_S, KEEP_DAYS, ALERTS_PER_TICK,
};

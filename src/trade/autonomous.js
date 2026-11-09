/**
 * Autonomous trading (milestone 2): RektBull's session key makes trades
 * through a user's permission, without asking each time.
 *
 * Every trade is a call to the Trade Router's swap, redeemed through MetaMask's
 * DelegationManager from the user's own smart account. The onchain rules
 * (only the router, the user's limits, output only to the user, fee at most
 * 1%, price near the reference) apply whatever this code does. This code adds
 * the off-chain rules on top and refuses early, so a trade that would fail
 * onchain is never sent:
 *   - trading is on, the user's permission is active (not revoked or expired),
 *     and the token is one the router trades (it has a price feed);
 *   - a buy is within the user's own per-trade amount (trade_settings);
 *   - on mainnet, RektBull's token check must pass (test tokens have no check);
 *   - the exact transaction is simulated first: if the router or MetaMask's
 *     rules would refuse it, it fails here with their reason and nothing is sent.
 *
 * One trade service instance sends at a time (a Postgres advisory lock), so
 * the session key's nonces never collide. Each signature is logged first.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const core = require('@metamask/delegation-core');
const abis = require('@metamask/delegation-abis');
const stops = require('../admin/stops');
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const { rpcUrls } = require('../providers/chains');
const networks = require('./networks');
const venues = require('./venues');
const rules = require('./rules');
const { sessionSigner, logSignature, TESTNETS } = require('./signers');

const ROUTER = new ethers.Interface([
  'function swap((address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address venue, address spender, bytes venueCalldata, uint256 deadline) p) returns (uint256)',
  'function swapWithSpendPermission((address account, address spender, address token, uint160 allowance, uint48 period, uint48 start, uint48 end, uint256 salt, bytes extraData) sp, (address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address venue, address spender, bytes venueCalldata, uint256 deadline) p) returns (uint256)',
  'function FEE_BPS() view returns (uint16)',
  'function boughtByRouter(address account, address token) view returns (uint256)',
  'event Swapped(address indexed account, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 fee, uint256 amountOut, uint256 valueUsd, uint256 countedUsd)',
  'error BadConfig()', 'error NotAllowed()', 'error LimitsOff()', 'error OverTradeLimit(uint256 valueUsd, uint256 limitUsd)',
  'error OverPeriodLimit(uint256 spentUsd, uint256 limitUsd)', 'error NoPrice(address token)', 'error StalePrice(address token)',
  'error SequencerDown()', 'error Expired()', 'error BelowMinimum(uint256 amountOut, uint256 minimum)', 'error VenueFailed(bytes reason)',
]);
const DM = new ethers.Interface(abis.DelegationManager);
const SWAP_TUPLE = '(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address venue, address spender, bytes venueCalldata, uint256 deadline)';
// Coinbase's Spend Permission Manager errors a spend can hit.
const SPEND_PERMISSIONS = new ethers.Interface([
  'error BeforeSpendPermissionStart(uint48 currentTimestamp, uint48 start)', 'error AfterSpendPermissionEnd(uint48 currentTimestamp, uint48 end)',
  'error ExceededSpendPermission(uint256 value, uint256 allowance)', 'error UnauthorizedSpendPermission()', 'error InvalidSender(address sender, address expected)',
]);
const SAFE_MODULE = new ethers.Interface([`function swap(address safe, ${SWAP_TUPLE} p) returns (uint256)`,
  'error BadSession()', 'error NotSessionKey()', 'error SessionExpired()', 'error SafeCallFailed(bytes reason)']);
const DELEGATOR = new ethers.Interface(abis.EIP7702StatelessDeleGator);
const SINGLE_DEFAULT_MODE = ethers.ZeroHash;
const NOT_SEEN_MINUTES = 30;
const LOCK_ID = 727001; // pg advisory lock: one sender at a time

class IntentRefused extends Error { constructor(m) { super(m); this.status = 422; } }

/** Why a call reverted, in words: a router or MetaMask error by name, or the revert string. */
function revertReason(err) {
  let data = err?.data || err?.info?.error?.data || err?.error?.data;
  if (data && typeof data === 'object') data = data.data;
  if (typeof data === 'string' && data.length >= 10) {
    for (const iface of [ROUTER, SAFE_MODULE, SPEND_PERMISSIONS, DM, DELEGATOR]) {
      try { const e = iface.parseError(data); if (e) return humanError(e); } catch { /* not this one */ }
    }
    try { return ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0]; } catch { /* not a string */ }
  }
  if (typeof data === 'string' && /^0x[0-9a-f]{8}/i.test(data)) return `the transaction would revert (error ${data.slice(0, 10)})`;
  // Some nodes give only the error's name in the message.
  const named = /custom error '(\w+)\(/.exec(String(err?.message || ''));
  if (named) return humanError({ name: named[1], args: [] });
  return err?.shortMessage || err?.reason || err?.message || 'the trade would fail onchain';
}

function humanError(e) {
  if (e.name === 'SafeCallFailed' && e.args?.[0] && e.args[0] !== '0x') return revertReason({ data: e.args[0] });
  if (e.name === 'NotSessionKey') return 'the Safe\'s session on the RektBull module doesn\'t name RektBull\'s key';
  if (e.name === 'SessionExpired') return 'the Safe\'s session on the RektBull module has expired';
  if (e.name === 'BeforeSpendPermissionStart') return 'the Coinbase spend permission hasn\'t started yet';
  if (e.name === 'AfterSpendPermissionEnd') return 'the Coinbase spend permission has ended: grant a new one';
  if (e.name === 'ExceededSpendPermission') return 'over the Coinbase spend permission\'s allowance for this period';
  if (e.name === 'UnauthorizedSpendPermission') return 'the Coinbase spend permission isn\'t approved, or was revoked';
  if (e.name === 'NotAllowed') return 'the router refused: the wallet hasn\'t named RektBull\'s key as operator, or the permission doesn\'t fit this trade';
  const usd = v => `$${(Number(v) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  switch (e.name) {
    case 'Error': return String(e.args?.[0] ?? 'the trade was refused'); // a plain revert message, e.g. a MetaMask enforcer's
    case 'Panic': return 'a contract failed unexpectedly';
    case 'OverTradeLimit': return e.args.length ? `over your per-trade limit (${usd(e.args[0])} > ${usd(e.args[1])})` : 'over your per-trade limit';
    case 'OverPeriodLimit': return e.args.length ? `over your daily limit (${usd(e.args[0])} > ${usd(e.args[1])})` : 'over your daily limit';
    case 'LimitsOff': return 'your trading limits are off or expired on the router';
    case 'StalePrice': return 'the reference price is out of date, so the router refuses to trade';
    case 'BelowMinimum': return 'the exchange offered a price too far below the reference price';
    case 'SequencerDown': return 'the network\'s sequencer is down or just restarted';
    case 'NoPrice': return 'the router has no reference price for this token';
    default: return e.name;
  }
}

// One connection per network, reused: a new provider per trade would leak connections.
const providers = new Map();
function provider(net) {
  const url = rpcUrls(net.name)[0];
  const key = `${net.chainId}|${url}`;
  if (!providers.has(key)) {
    // No response cache: ethers otherwise reuses identical calls for 250 ms, which can hand back a stale nonce.
    providers.set(key, new ethers.JsonRpcProvider(url, net.chainId, { staticNetwork: true, cacheTimeout: -1 }));
  }
  return providers.get(key);
}

/** Closes the network connections (tests and shutdown). */
function close() {
  for (const p of providers.values()) p.destroy();
  providers.clear();
}

async function activePermission(accountId, chainId) {
  const { rows } = await db.query(
    `SELECT * FROM trade_permissions WHERE account_id = $1 AND chain_id = $2 AND status = 'active' AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
    [accountId, chainId],
  );
  return rows[0] || null;
}

/** Queues an autonomous trade for the signed-in wallet. */
async function queue(account, input, { source = 'user', reason = null } = {}) {
  if (!env.tradingEnabled) throw new IntentRefused('Trading is switched off (TRADING_ENABLED).');
  if (await stops.isStopped('auto_trading')) throw new IntentRefused('Automatic trading is paused by RektBull for now. You can still trade from your own wallet on the Trade desk.');
  const net = networks.network(Number(input.chain_id));
  const perm = await activePermission(account.id, net.chainId);
  if (!perm) throw new IntentRefused('There is no active automatic-trading permission for this wallet on this network. Grant one first.');
  const side = input.side;
  if (!['buy', 'sell'].includes(side)) throw new IntentRefused('side must be "buy" or "sell".');
  const token = networks.routerToken(net, input.token);
  const base = networks.routerToken(net, input.base || net.defaultBase);
  if (!token || !base) throw new IntentRefused(`automatic trading only covers tokens the router has a reference price for: ${Object.keys(net.tokens).join(', ')}`);
  if (token.address === base.address) throw new IntentRefused('token and base must differ.');
  let amountUsd = null;
  let sellAmount = null;
  if (side === 'buy') {
    amountUsd = Number(input.amount_usd);
    if (!(amountUsd > 0)) throw new IntentRefused('amount_usd must be a positive number for a buy.');
    const settings = await rules.settingsFor(account.id);
    if (amountUsd > settings.max_trade_usd) throw new IntentRefused(`$${amountUsd} is over your per-trade amount of $${settings.max_trade_usd}.`);
  } else {
    sellAmount = input.sell_amount ? BigInt(input.sell_amount) : null;
    if (!sellAmount) {
      const { rows } = await db.query('SELECT amount_raw FROM positions WHERE account_id = $1 AND chain = $2 AND token = $3', [account.id, net.name, token.address]);
      const held = rows.length ? BigInt(rows[0].amount_raw) : 0n;
      const fraction = Number(input.sell_fraction ?? 1);
      if (!(fraction > 0 && fraction <= 1)) throw new IntentRefused('sell_fraction must be above 0 and at most 1.');
      sellAmount = held * BigInt(Math.round(fraction * 10000)) / 10000n;
    }
    if (sellAmount <= 0n) throw new IntentRefused('nothing to sell: RektBull hasn\'t bought any of this token for you.');
  }
  const id = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO trade_intents (id, account_id, wallet, chain_id, permission_id, side, token, base, amount_usd, sell_amount, source, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [id, account.id, perm.wallet, net.chainId, perm.id, side, token.address, base.address, amountUsd, sellAmount === null ? null : sellAmount.toString(), source, reason],
  );
  return present(rows[0]);
}

function present(r) {
  return {
    id: r.id, chain_id: r.chain_id, side: r.side, token: r.token, base: r.base,
    amount_usd: r.amount_usd === null ? null : Number(r.amount_usd), sell_amount: r.sell_amount,
    source: r.source, reason: r.reason, status: r.status, tx_hash: r.tx_hash, result: r.result, error: r.error,
    created_at: r.created_at, sent_at: r.sent_at, finished_at: r.finished_at,
  };
}

async function fail(intent, message) {
  await db.query(`UPDATE trade_intents SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [intent.id, message]);
  if (intent.source === 'exit') await db.query('UPDATE positions SET exit_intent_id = NULL WHERE exit_intent_id = $1', [intent.id]);
  logger.info('autonomous trade refused', { intent: intent.id, reason: message });
}

/**
 * The transaction RektBull's session key sends for one trade, by wallet type.
 * Each goes through the router's swap, and each wallet's own rules apply on
 * top: MetaMask's caveats, the Safe module's session, Coinbase's spend permission.
 */
function tradeCall(net, perm, params) {
  const d = perm.delegation;
  if (perm.wallet_type === 'metamask') {
    return {
      to: net.delegationManager,
      data: DM.encodeFunctionData('redeemDelegations', [
        [core.encodeDelegations([{ ...d, salt: BigInt(d.salt), caveats: d.caveats.map(c => ({ ...c, args: c.args || '0x' })) }])],
        [SINGLE_DEFAULT_MODE],
        [ethers.solidityPacked(['address', 'uint256', 'bytes'], [net.router, 0, ROUTER.encodeFunctionData('swap', [params])])],
      ]),
    };
  }
  if (perm.wallet_type === 'safe') {
    if (!net.safeModule) throw new Error('Safe trading isn\'t set up on this network');
    return { to: net.safeModule, data: SAFE_MODULE.encodeFunctionData('swap', [d.safe, params]) };
  }
  if (perm.wallet_type === 'coinbase') {
    const sp = (d.spend_permissions || []).find(x => String(x.token).toLowerCase() === String(params.tokenIn).toLowerCase());
    if (!sp) throw new Error('there is no Coinbase spend permission for the token being sold: grant one for it first');
    const tuple = [sp.account, sp.spender, sp.token, BigInt(sp.allowance), Number(sp.period), Number(sp.start), Number(sp.end), BigInt(sp.salt), sp.extraData || '0x'];
    return { to: net.router, data: ROUTER.encodeFunctionData('swapWithSpendPermission', [tuple, params]) };
  }
  throw new Error(`automatic trading isn't available for ${perm.wallet_type} wallets`);
}

/** Builds, simulates, signs and sends one queued trade. */
async function execute(intent) {
  const net = networks.network(intent.chain_id);
  const { rows: permRows } = await db.query('SELECT * FROM trade_permissions WHERE id = $1', [intent.permission_id]);
  const perm = permRows[0];
  if (!perm || perm.status !== 'active' || new Date(perm.expires_at) <= new Date()) return fail(intent, 'the permission was revoked or has expired');
  if (!env.tradingEnabled) return fail(intent, 'trading is switched off');
  if (!TESTNETS.has(net.chainId)) {
    // Mainnet: the same token check as approve-each buys. (Test tokens have none.)
    if (intent.side === 'buy') {
      const risk = await require('../services/dueDiligence').quickCheck({ chain: net.name, token: intent.token });
      if (risk.incomplete || ['critical', 'high'].includes(risk.verdict)) return fail(intent, `RektBull's token check refused it (${risk.verdict})`);
    }
  }

  const tokenIn = intent.side === 'buy' ? intent.base : intent.token;
  const tokenOut = intent.side === 'buy' ? intent.token : intent.base;
  let amountIn;
  let v;
  try {
    // Reading prices from the router can itself be refused (a stale price, a down sequencer).
    amountIn = intent.side === 'buy'
      ? await venues.view(net, 'amountForUsd', [tokenIn, BigInt(Math.round(Number(intent.amount_usd) * 1e8))])
      : BigInt(intent.sell_amount);
    v = await venues.venueCall(net, { tokenIn, tokenOut, amountIn });
  } catch (err) {
    return fail(intent, `refused before sending: ${revertReason(err)}`);
  }
  const settings = await rules.settingsFor(intent.account_id);
  const params = {
    tokenIn, tokenOut, amountIn, minAmountOut: v.expectedOut * BigInt(10000 - settings.slippage_bps) / 10000n,
    venue: v.venue, spender: v.spender, venueCalldata: v.venueCalldata, deadline: Math.floor(Date.now() / 1000) + 300,
  };
  let call;
  try {
    call = tradeCall(net, perm, params);
  } catch (err) {
    return fail(intent, err.message);
  }

  const p = provider(net);
  const signer = await sessionSigner(net.chainId, p);
  const from = await signer.getAddress();
  try {
    await p.call({ from, ...call });
  } catch (err) {
    return fail(intent, `refused before sending: ${revertReason(err)}`);
  }
  const tx = await signer.populateTransaction(call);
  tx.gasLimit = (BigInt(tx.gasLimit) * 13n) / 10n;
  const unsigned = ethers.Transaction.from({ ...tx, from: undefined });
  await logSignature(from, unsigned.unsignedHash, `redeem:${intent.id}`);
  const raw = await signer.signTransaction(tx);
  const hash = ethers.keccak256(raw);
  // Record the hash before broadcasting: a crash in between is then checked against the chain, never resent blindly.
  await db.query(`UPDATE trade_intents SET status = 'sent', tx_hash = $2, sent_at = now() WHERE id = $1`, [intent.id, hash]);
  await p.broadcastTransaction(raw);
  logger.info('autonomous trade sent', { intent: intent.id, tx: hash });
}

/** Confirms a sent trade from its receipt and the router's Swapped event. */
async function confirm(intent) {
  const net = networks.network(intent.chain_id);
  const p = provider(net);
  const receipt = await p.getTransactionReceipt(intent.tx_hash);
  if (!receipt) {
    if (Date.now() - new Date(intent.sent_at).getTime() > NOT_SEEN_MINUTES * 60 * 1000) await fail(intent, 'the transaction was not seen onchain within 30 minutes');
    return;
  }
  if (receipt.status !== 1) return fail(intent, 'the transaction reverted onchain');
  const ev = receipt.logs.filter(l => l.address.toLowerCase() === net.router).map(l => { try { return ROUTER.parseLog(l); } catch { return null; } }).find(e => e?.name === 'Swapped');
  if (!ev || ev.args.account.toLowerCase() !== intent.wallet.toLowerCase()) return fail(intent, 'the transaction did not make this trade for this wallet');
  const amountIn = ev.args.amountIn;
  const amountOut = ev.args.amountOut;
  const valueUsd = Number(ev.args.valueUsd) / 1e8;
  await db.tx(async c => {
    if (intent.side === 'buy') {
      await c.query(
        `INSERT INTO positions (account_id, chain, token, amount_raw, cost_usd) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, chain, token) DO UPDATE SET amount_raw = positions.amount_raw + $4, cost_usd = positions.cost_usd + $5, updated_at = now()`,
        [intent.account_id, net.name, intent.token, amountOut.toString(), valueUsd],
      );
    } else {
      await c.query(
        `UPDATE positions SET
           cost_usd = CASE WHEN amount_raw <= $4 THEN 0 ELSE cost_usd * (amount_raw - $4) / amount_raw END,
           amount_raw = GREATEST(amount_raw - $4, 0), exit_intent_id = NULL,
           exit_reason = CASE WHEN $5 THEN $6 ELSE exit_reason END, updated_at = now()
         WHERE account_id = $1 AND chain = $2 AND token = $3`,
        [intent.account_id, net.name, intent.token, amountIn.toString(), intent.source === 'exit', intent.reason],
      );
    }
    await c.query(`UPDATE trade_intents SET status = 'confirmed', result = $2, finished_at = now() WHERE id = $1`, [intent.id, JSON.stringify({
      amount_in: amountIn.toString(), amount_out: amountOut.toString(), fee: ev.args.fee.toString(), value_usd: valueUsd,
      counted_usd: Number(ev.args.countedUsd) / 1e8, explorer: net.explorerTx ? net.explorerTx + intent.tx_hash : null,
    })]);
  });
  logger.info('autonomous trade confirmed', { intent: intent.id });
}

/** One pass: confirm what was sent, then send what is queued, one at a time. */
async function tick() {
  const client = await db.getPool().connect();
  try {
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (!lock.ok) return;
    try {
      const { rows: sent } = await db.query(`SELECT * FROM trade_intents WHERE status = 'sent' ORDER BY sent_at LIMIT 50`);
      for (const i of sent) await confirm(i).catch(err => logger.error('autonomous confirm failed', { intent: i.id, error: err.message }));
      // The emergency stop (admin panel): what's waiting is cancelled, not kept for later at a stale price.
      if (await stops.isStopped('auto_trading')) {
        const { rows: waiting } = await db.query(`SELECT * FROM trade_intents WHERE status = 'queued'`);
        for (const i of waiting) await fail(i, 'Cancelled: automatic trading was paused by RektBull. Nothing was sent.').catch(err => logger.error('could not cancel a queued trade', { intent: i.id, error: err.message }));
        return;
      }
      const { rows: queued } = await db.query(`SELECT * FROM trade_intents WHERE status = 'queued' ORDER BY created_at LIMIT 10`);
      for (const i of queued) {
        try { await execute(i); } catch (err) {
          logger.error('autonomous trade failed', { intent: i.id, error: err.message });
          const { rows } = await db.query('SELECT status FROM trade_intents WHERE id = $1', [i.id]);
          if (rows[0]?.status === 'queued') await fail(i, err.message);
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

async function list(account) {
  const { rows } = await db.query('SELECT * FROM trade_intents WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50', [account.id]);
  return rows.map(present);
}

async function cancel(account, id) {
  const { rows } = await db.query(`UPDATE trade_intents SET status = 'cancelled', finished_at = now() WHERE id = $1 AND account_id = $2 AND status = 'queued' RETURNING *`, [id, account.id]);
  if (!rows.length) throw Object.assign(new Error('only a queued trade can be cancelled'), { status: 409 });
  return present(rows[0]);
}

module.exports = { queue, execute, confirm, tick, list, cancel, close, revertReason, IntentRefused, ROUTER };

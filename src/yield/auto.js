/**
 * Automatic yield rebalancing, with session keys. BUILT, AND SWITCHED OFF:
 * nothing here runs, and no permission is accepted, unless
 * YIELD_AUTO_ENABLED=true, which waits for the Yield Router's audit.
 *
 * The user keeps their wallet. They give RektBull's session key a MetaMask
 * delegation (EIP-7702 account) that may only call the RektBull Yield Router
 * (contracts/RektBullYieldRouter.sol): deposit, move and withdraw, nothing
 * else. The router enforces onchain what makes that safe: positions only for
 * the user, withdrawals only to the user, moves only to a venue paying more
 * right now, at most one deposit or move a day, the user's own per-asset
 * limits and expiry, and a fee of at most 0.1% to the fixed fee wallet.
 *
 * Each pass (trade service, every tick), for each active permission:
 *   1. A critical risk warning on a venue the wallet holds: withdraw it all,
 *      back to the wallet (always allowed, never charged).
 *   2. Otherwise, when the router's interval has passed: the best proposal on
 *      that chain (the same rules as proposals.js), capped at the user's
 *      onchain limit for the asset, as a deposit or move through the router.
 *   Each action is simulated, its signature logged, then sent; the next pass
 *   reads its receipt.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const core = require('@metamask/delegation-core');
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const { evmRpc } = require('../providers/rpc');
const { rpcUrls } = require('../providers/chains');
const permissions = require('../trade/permissions');
const signers = require('../trade/signers');
const venues = require('./venues');
const rules = require('./rules');

const ROUTER = new ethers.Interface([
  'function deposit(uint256 id, uint256 amount)', 'function move(uint256 fromId, uint256 toId, uint256 amount)', 'function withdraw(uint256 id, uint256 amount)',
  'function validUntil(address) view returns (uint64)', 'function maxPerMove(address, address) view returns (uint256)',
  'function lastMoveAt(address) view returns (uint256)', 'function MIN_INTERVAL() view returns (uint32)',
  'function MIN_GAIN_BPS() view returns (uint16)', 'function rateOf(uint256 id) view returns (uint256)',
  'function venueCount() view returns (uint256)', 'function venueAt(uint256 id) view returns (tuple(uint8 kind, address target, address asset, address position, address rateSource))',
  'function setLimits(address[] assets, uint256[] limits, uint64 until)', 'function revoke()',
  'event Deposited(address indexed account, uint256 indexed venue, uint256 amount, uint256 fee)',
  'event Moved(address indexed account, uint256 indexed fromVenue, uint256 indexed toVenue, uint256 amount, uint256 fee, uint256 fromRate, uint256 toRate)',
  'event Withdrawn(address indexed account, uint256 indexed venue, uint256 amount)',
]);
const DM = new ethers.Interface(['function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)']);
const ERC20 = new ethers.Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const COMET = new ethers.Interface(['function allow(address manager, bool isAllowed)']);
const SELECTORS = ['deposit', 'move', 'withdraw'].map(n => ROUTER.getFunction(n).selector);
const SINGLE_DEFAULT_MODE = ethers.ZeroHash;
const chainById = Object.fromEntries(Object.entries(venues.CHAINS).map(([k, v]) => [v.chainId, k]));
const lower = a => String(a || '').toLowerCase();

class AutoRefused extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

function routerFor(chainId) {
  const router = env.yieldRouters?.[String(chainId)];
  if (!router) throw new AutoRefused(`the Yield Router isn't deployed on chain ${chainId} yet`, 503);
  return lower(router);
}
const chainOf = chainId => { const c = chainById[Number(chainId)]; if (!c) throw new AutoRefused(`automatic rebalancing runs on ${Object.keys(venues.CHAINS).join(', ')}`, 400); return c; };
const view = async (chain, to, fn, args = []) => ROUTER.decodeFunctionResult(fn, await evmRpc(chain, 'eth_call', [{ to, data: ROUTER.encodeFunctionData(fn, args) }, 'latest']));

/** The router onchain lists exactly our venues, in our order (so ids mean what we think). */
async function checkRouter(chain, router) {
  const ours = venues.routerVenues(chain);
  const [n] = await view(chain, router, 'venueCount');
  if (Number(n) !== ours.length) throw new AutoRefused('the Yield Router on this chain lists different venues than RektBull: refusing');
  for (const v of ours) {
    const [onchain] = await view(chain, router, 'venueAt', [v.id]);
    if (Number(onchain.kind) !== v.kind || lower(onchain.target) !== lower(v.target) || lower(onchain.asset) !== v.assetAddress || lower(onchain.position) !== lower(v.position)) {
      throw new AutoRefused(`the Yield Router's venue ${v.id} isn't ${v.protocol} ${v.asset}: refusing`);
    }
  }
  return ours;
}

/** The calls the user's own wallet signs once to set up: approvals to the router (it only pulls from the caller), Comet's allow, and limits. */
function setupCalls(chainId, { limits = {}, days = 30 } = {}) {
  const chain = chainOf(chainId);
  const router = routerFor(chainId);
  const calls = [];
  const seen = new Set();
  for (const v of venues.routerVenues(chain)) {
    for (const t of [v.assetAddress, v.position]) {
      if (seen.has(lower(t)) || (v.kind === 2 && lower(t) === lower(v.target))) continue;
      seen.add(lower(t));
      calls.push({ to: t, data: ERC20.encodeFunctionData('approve', [router, ethers.MaxUint256]), value: '0x0', label: `Let the Yield Router move ${t === v.assetAddress ? v.asset : `your ${v.protocol} ${v.asset} position`} for your own account only` });
    }
    if (v.kind === 2 && !seen.has(`allow:${v.target}`)) {
      seen.add(`allow:${v.target}`);
      calls.push({ to: v.target, data: COMET.encodeFunctionData('allow', [router, true]), value: '0x0', label: 'Let the Yield Router withdraw your Compound position, only back to you' });
    }
  }
  const assets = Object.keys(limits).filter(a => venues.TOKENS[chain][a]);
  if (assets.length) {
    const until = Math.floor(Date.now() / 1000) + Math.min(days, 30) * 86400;
    calls.push({
      to: router, value: '0x0', label: `Set your limits: ${assets.map(a => `${limits[a]} ${a}`).join(', ')} per move, until ${new Date(until * 1000).toISOString().slice(0, 10)}`,
      data: ROUTER.encodeFunctionData('setLimits', [assets.map(a => venues.TOKENS[chain][a].address), assets.map(a => ethers.parseUnits(String(limits[a]), venues.TOKENS[chain][a].decimals)), until]),
    });
  }
  return { chain, router, calls, delegation: { target: router, selectors: SELECTORS, note: 'Then sign a delegation to RektBull\'s session key with four caveats: only that key may redeem it, it expires within 30 days, it may only call the Yield Router, and only its deposit, move and withdraw.' } };
}

/** Checks and stores a yield permission (a MetaMask delegation to the Yield Router). Refused while switched off. */
async function register(account, body, { sessionKey, onchain = null } = {}) {
  if (!env.yieldAutoEnabled) throw new AutoRefused('Automatic rebalancing is switched off for now (YIELD_AUTO_ENABLED). Proposals you sign yourself work as before.', 503);
  const chainId = Number(body.chain_id);
  const chain = chainOf(chainId);
  const router = routerFor(chainId);
  let c;
  try {
    c = permissions.checkDelegation({ delegation: body.delegation, chainId, wallet: account.wallet, sessionKey, allow: { target: router, selectors: SELECTORS, what: { target: 'the RektBull Yield Router', methods: 'the Yield Router\'s deposit, move and withdraw' } } });
  } catch (err) {
    if (err instanceof permissions.PermissionRefused) throw new AutoRefused(err.message);
    throw err;
  }
  await (onchain || (async () => {
    const code = lower(await evmRpc(chain, 'eth_getCode', [account.wallet, 'latest']));
    if (code !== lower('0xef0100' + c.delegatorImpl.slice(2))) throw new AutoRefused('your wallet is not yet a MetaMask smart account on this chain: switch it on in MetaMask first');
    await checkRouter(chain, router);
    const [until] = await view(chain, router, 'validUntil', [account.wallet]);
    if (!(Number(until) > Date.now() / 1000)) throw new AutoRefused('set your limits on the Yield Router first');
  }))();
  const { rows } = await db.query(
    `INSERT INTO yield_permissions (id, account_id, wallet, chain_id, router, delegate, delegation, delegation_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9))
     ON CONFLICT (delegation_hash) DO UPDATE SET status = yield_permissions.status RETURNING *`,
    [crypto.randomUUID(), account.id, lower(account.wallet), chainId, router, lower(sessionKey), JSON.stringify(body.delegation), c.hash, c.expiresAt],
  );
  return present(rows[0]);
}

const present = r => ({ id: r.id, chain_id: r.chain_id, wallet: r.wallet, router: r.router, status: r.status, expires_at: r.expires_at, created_at: r.created_at, revoked_at: r.revoked_at });

async function list(account) {
  await db.query(`UPDATE yield_permissions SET status = 'expired' WHERE account_id = $1 AND status = 'active' AND expires_at <= now()`, [account.id]);
  const { rows } = await db.query('SELECT * FROM yield_permissions WHERE account_id = $1 ORDER BY created_at DESC', [account.id]);
  return rows.map(present);
}

async function revoke(account, id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new AutoRefused('no active permission with that id', 404);
  const { rows } = await db.query(`UPDATE yield_permissions SET status = 'revoked', revoked_at = now() WHERE id = $1 AND account_id = $2 AND status = 'active' RETURNING *`, [id, account.id]);
  if (!rows.length) throw new AutoRefused('no active permission with that id', 404);
  return present(rows[0]);
}

/* ── deciding ── */

/**
 * What to do for one permission now: { kind: 'withdraw'|'deposit'|'move', ... } or { none: reason }.
 * deps lets tests stand in for the chain.
 */
async function plan(perm, deps = {}) {
  const chain = chainOf(perm.chain_id);
  const wallet = lower(perm.wallet);
  const read = deps.read || (fn => view(chain, perm.router, fn.name, fn.args));
  const positionsRead = deps.positions || (w => require('./positions').read(w, { chains: [chain] }));
  const warnings = deps.warnings || (async () => (await require('./risk').current()).warnings);
  const scan = deps.scan || (w => require('./proposals').scan(w));
  const ids = venues.routerVenues(chain);
  const idOf = (protocol, asset) => ids.find(v => v.protocol === protocol && v.asset === asset)?.id;

  // 1. Get out of a venue in trouble: always, at once, and free.
  const pos = await positionsRead(wallet);
  const critical = (await warnings()).filter(w => w.severity === 'critical' && w.chain === chain);
  for (const p of pos.positions) {
    const w = critical.find(x => x.protocol === p.protocol && x.asset === p.asset);
    const id = idOf(p.protocol, p.asset);
    if (w && id !== undefined && Number(p.amount) > 0) return { kind: 'withdraw', id, asset: p.asset, protocol: p.protocol, amount: ethers.MaxUint256, reason: `risk watcher: ${w.reason}` };
  }

  // 2. A deposit or move, when the router allows one now.
  const now = Math.floor(Date.now() / 1000);
  const [[until], [last], [interval]] = await Promise.all([read({ name: 'validUntil', args: [wallet] }), read({ name: 'lastMoveAt', args: [wallet] }), read({ name: 'MIN_INTERVAL', args: [] })]);
  if (!(Number(until) > now)) return { none: 'the limits on the Yield Router have expired or were revoked' };
  if (Number(last) && now < Number(last) + Number(interval)) return { none: `the router allows the next deposit or move after ${new Date((Number(last) + Number(interval)) * 1000).toISOString()}` };
  const s = await scan(wallet);
  // The router compares the venues' own onchain rates (no rewards), so a proposal it would refuse is skipped here.
  let gain;
  const rateCache = new Map();
  const rate = async id => { if (!rateCache.has(id)) rateCache.set(id, BigInt((await read({ name: 'rateOf', args: [id] }))[0])); return rateCache.get(id); };
  for (const p of s.proposals.filter(x => x.chain === chain)) {
    const toId = idOf(p.to.protocol, p.asset);
    const fromId = p.from.protocol ? idOf(p.from.protocol, p.asset) : null;
    if (toId === undefined || fromId === undefined) continue;
    if (gain === undefined) gain = BigInt((await read({ name: 'MIN_GAIN_BPS', args: [] }))[0]) * 10n ** 14n;
    const toRate = await rate(toId);
    if (fromId === null) {
      // A deposit only into the best venue for the asset, or one within MIN_GAIN_BPS of it.
      let best = 0n;
      for (const v of ids.filter(x => x.asset === p.asset)) { const r = await rate(v.id); if (r > best) best = r; }
      if (toRate + gain < best) continue;
    } else if (toRate < (await rate(fromId)) + gain) continue; // a move only to a venue paying MIN_GAIN_BPS more
    const token = venues.tokenOf(chain, p.asset);
    const [limit] = await read({ name: 'maxPerMove', args: [wallet, token.address] });
    if (BigInt(limit) === 0n) continue;
    let units = ethers.parseUnits(Number(p.amount).toFixed(token.decimals), token.decimals);
    if (units > BigInt(limit)) units = BigInt(limit);
    const usd = Number(ethers.formatUnits(units, token.decimals)) * (p.amount_usd / Number(p.amount));
    // The proposal passed for its amount; check the capped amount again (break-even depends on it).
    const r = await (deps.evaluate || rules.evaluate)({ chain, source: p.from.protocol, target: p.to.protocol, asset: p.asset, amountUsd: usd, positions: pos, feeBps: require('./proposals').feeBps() });
    if (!r.allowed) continue;
    return fromId === null
      ? { kind: 'deposit', id: toId, asset: p.asset, protocol: p.to.protocol, amount: units, reason: `${p.to.name} pays ${p.to.apy_pct}%`, checks: r.checks }
      : { kind: 'move', fromId, id: toId, asset: p.asset, protocol: p.to.protocol, from: p.from.protocol, amount: units, reason: `${p.to.name} pays ${p.to.apy_pct}%, ${p.from.name} ${p.from.apy_pct}%`, checks: r.checks };
  }
  return { none: 'no move passes the rules within your limits' };
}

/* ── doing ── */

function redeemCall(perm, action) {
  const d = typeof perm.delegation === 'string' ? JSON.parse(perm.delegation) : perm.delegation;
  const inner = action.kind === 'move' ? ROUTER.encodeFunctionData('move', [action.fromId, action.id, action.amount])
    : ROUTER.encodeFunctionData(action.kind, [action.id, action.amount]);
  return {
    to: permissions.mmContracts(Number(perm.chain_id)).DelegationManager,
    data: DM.encodeFunctionData('redeemDelegations', [
      [core.encodeDelegations([{ ...d, salt: BigInt(d.salt), caveats: d.caveats.map(c => ({ ...c, args: c.args || '0x' })) }])],
      [SINGLE_DEFAULT_MODE],
      [ethers.solidityPacked(['address', 'uint256', 'bytes'], [perm.router, 0, inner])],
    ]),
  };
}

const providers = new Map();
function providerFor(chain) {
  const url = rpcUrls(chain)[0];
  if (!providers.has(url)) providers.set(url, new ethers.JsonRpcProvider(url, venues.CHAINS[chain].chainId, { staticNetwork: true, cacheTimeout: -1 }));
  return providers.get(url);
}
function close() { for (const p of providers.values()) p.destroy(); providers.clear(); }

/** Simulates, logs, signs and sends one action. */
async function execute(perm, action) {
  const chain = chainOf(perm.chain_id);
  const call = redeemCall(perm, action);
  const p = providerFor(chain);
  const signer = await signers.sessionSigner(Number(perm.chain_id), p);
  const from = await signer.getAddress();
  const id = crypto.randomUUID();
  const record = (status, extra = {}) => db.query(
    `INSERT INTO yield_auto_actions (id, permission_id, kind, from_venue, to_venue, asset, amount_raw, reason, status, tx_hash, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, perm.id, action.kind, action.fromId ?? null, action.id, action.asset, action.amount === ethers.MaxUint256 ? null : action.amount.toString(), action.reason, status, extra.tx || null, extra.error || null],
  );
  try { await p.call({ from, ...call }); } catch (err) {
    await record('failed', { error: `refused before sending: ${err.shortMessage || err.message}`.slice(0, 500) });
    return { id, status: 'failed' };
  }
  const tx = await signer.populateTransaction(call);
  tx.gasLimit = (BigInt(tx.gasLimit) * 13n) / 10n;
  const unsigned = ethers.Transaction.from({ ...tx, from: undefined });
  await signers.logSignature(from, unsigned.unsignedHash, `yield:${id}`);
  const raw = await signer.signTransaction(tx);
  const hash = ethers.keccak256(raw);
  await record('sent', { tx: hash }); // the hash is recorded before broadcasting, so a crash is checked, never resent blindly
  await p.broadcastTransaction(raw);
  logger.info('automatic yield action sent', { action: id, kind: action.kind, tx: hash });
  return { id, status: 'sent', tx: hash };
}

/** Reads receipts of sent actions. */
async function confirmSent() {
  const { rows } = await db.query(`SELECT a.*, p.chain_id FROM yield_auto_actions a JOIN yield_permissions p ON p.id = a.permission_id WHERE a.status = 'sent'`);
  for (const a of rows) {
    const r = await evmRpc(chainOf(a.chain_id), 'eth_getTransactionReceipt', [a.tx_hash]).catch(() => null);
    if (!r) continue;
    await db.query(`UPDATE yield_auto_actions SET status = $2, confirmed_at = now() WHERE id = $1`, [a.id, r.status === '0x1' ? 'confirmed' : 'failed']);
  }
}

/** The trade service's job. Does nothing while switched off. */
async function tick(deps = {}) {
  if (!env.yieldAutoEnabled) return { off: true };
  await confirmSent();
  if (await require('../admin/stops').isStopped('auto_yield')) return { stopped: true }; // the emergency stop (admin panel)
  await db.query(`UPDATE yield_permissions SET status = 'expired' WHERE status = 'active' AND expires_at <= now()`);
  const { rows } = await db.query(`SELECT * FROM yield_permissions WHERE status = 'active'`);
  const done = [];
  for (const perm of rows) {
    const { rows: pending } = await db.query(`SELECT 1 FROM yield_auto_actions WHERE permission_id = $1 AND status = 'sent'`, [perm.id]);
    if (pending.length) continue;
    try {
      const action = await plan(perm, deps);
      if (action.none) continue;
      done.push({ permission: perm.id, ...(await (deps.execute || execute)(perm, action)), kind: action.kind });
    } catch (err) {
      logger.warn('automatic yield pass failed', { permission: perm.id, error: err.message });
    }
  }
  return { done };
}

module.exports = { register, list, revoke, plan, execute, tick, setupCalls, checkRouter, redeemCall, close, AutoRefused, SELECTORS, ROUTER };

/**
 * The registry of automatic-trading permissions (docs/SESSION_KEYS.md).
 *
 * A permission is a MetaMask delegation from the user's own wallet to
 * RektBull's session key. Before one is stored, everything that makes it
 * safe is checked, so RektBull never holds a permission broader than the
 * design allows, even by mistake:
 *   - it's from the signed-in wallet, to RektBull's session key, as a root delegation;
 *   - its caveats are exactly the four RektBull asks for: only RektBull's key
 *     may redeem it, it expires within 30 days, it may only call this chain's
 *     Trade Router, and only the router's `swap`;
 *   - the signature is the wallet's own (EIP-712, recovered);
 *   - onchain: the wallet is a MetaMask smart account (EIP-7702), and its
 *     limits are set on the router.
 *
 * Wallet types (each with its own break-it tests in contracts/test):
 *   - metamask: the delegation above, from the signed-in EIP-7702 account.
 *   - safe: the RektBull Safe Module. The signed-in wallet must be one of the
 *     Safe's owners; onchain, the module is enabled on the Safe, its session
 *     names RektBull's key, and the Safe has limits on the router.
 *   - coinbase: Coinbase spend permissions to the Trade Router (never to a
 *     RektBull key). The signed-in wallet is the Coinbase Smart Wallet itself;
 *     onchain, each permission is approved and not revoked, its spender is the
 *     router, its token is one the router trades, the wallet named RektBull's
 *     key as its operator on the router, and it has limits there.
 *   Phantom comes with Solana.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const core = require('@metamask/delegation-core');
const { DELEGATOR_CONTRACTS } = require('@metamask/delegation-deployments');
const db = require('../config/db');
const { evmRpc } = require('../providers/rpc');
const networks = require('./networks');

const MM_VERSION = '1.3.0';
const MAX_DAYS = 30;
const SWAP_SELECTOR = ethers.id('swap((address,address,uint256,uint256,address,address,bytes,uint256))').slice(0, 10);
const ROUTER = new ethers.Interface([
  'function limits(address) view returns (uint128 perTradeUsd, uint128 perPeriodUsd, uint32 periodSeconds, uint64 validUntil)',
  'function operatorOf(address) view returns (address)',
]);
const SAFE = new ethers.Interface(['function isOwner(address owner) view returns (bool)', 'function isModuleEnabled(address module) view returns (bool)']);
const MODULE = new ethers.Interface(['function sessions(address safe) view returns (address key, uint64 validUntil)']);
const PERM = '(address account, address spender, address token, uint160 allowance, uint48 period, uint48 start, uint48 end, uint256 salt, bytes extraData)';
const SPM = new ethers.Interface([`function isApproved(${PERM} spendPermission) view returns (bool)`, `function isRevoked(${PERM} spendPermission) view returns (bool)`]);

class PermissionRefused extends Error {
  constructor(message) { super(message); this.status = 422; }
}

function routerFor(chainId) {
  try { return networks.network(chainId).router; } catch { throw new PermissionRefused(`automatic trading isn't available on chain ${chainId} yet`); }
}

function mmContracts(chainId) {
  const c = DELEGATOR_CONTRACTS[MM_VERSION]?.[chainId];
  if (!c) throw new PermissionRefused(`MetaMask's delegation contracts aren't deployed on chain ${chainId}`);
  return c;
}

const chainName = chainId => networks.network(chainId).name;

const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

const TYPES = {
  Delegation: [
    { name: 'delegate', type: 'address' }, { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' }, { name: 'caveats', type: 'Caveat[]' }, { name: 'salt', type: 'uint256' },
  ],
  Caveat: [{ name: 'enforcer', type: 'address' }, { name: 'terms', type: 'bytes' }],
};

/**
 * Checks a delegation's shape, caveats and signature; returns what it
 * allows, or throws PermissionRefused saying what's wrong. No network.
 */
function checkDelegation({ delegation: d, chainId, wallet, sessionKey, now = Math.floor(Date.now() / 1000) }) {
  const mm = mmContracts(chainId);
  const router = routerFor(chainId);
  if (!d || typeof d !== 'object') throw new PermissionRefused('delegation is missing');
  if (!eq(d.delegator, wallet)) throw new PermissionRefused('the delegation is not from your signed-in wallet');
  if (!eq(d.delegate, sessionKey)) throw new PermissionRefused('the delegation is not to RektBull\'s session key');
  if (!eq(d.authority, core.ROOT_AUTHORITY)) throw new PermissionRefused('only a direct (root) delegation is accepted');
  const caveats = Array.isArray(d.caveats) ? d.caveats : [];
  if (caveats.length !== 4) throw new PermissionRefused('the delegation must carry exactly RektBull\'s four caveats');

  const byEnforcer = name => {
    const found = caveats.filter(c => eq(c.enforcer, mm[name]));
    if (found.length !== 1) throw new PermissionRefused(`the delegation must have one ${name} caveat`);
    if (found[0].args && found[0].args !== '0x') throw new PermissionRefused(`the ${name} caveat must not carry arguments`);
    return found[0].terms;
  };
  const redeemers = core.decodeRedeemerTerms(byEnforcer('RedeemerEnforcer')).redeemers;
  if (redeemers.length !== 1 || !eq(redeemers[0], sessionKey)) throw new PermissionRefused('only RektBull\'s session key may be allowed to use it');
  const { afterThreshold, beforeThreshold } = core.decodeTimestampTerms(byEnforcer('TimestampEnforcer'));
  if (!(beforeThreshold > now)) throw new PermissionRefused('the delegation has already expired');
  if (beforeThreshold > now + MAX_DAYS * 86400) throw new PermissionRefused(`the delegation must expire within ${MAX_DAYS} days`);
  if (afterThreshold > now + 3600) throw new PermissionRefused('the delegation must be usable now');
  const targets = core.decodeAllowedTargetsTerms(byEnforcer('AllowedTargetsEnforcer')).targets;
  if (targets.length !== 1 || !eq(targets[0], router)) throw new PermissionRefused('it may only allow calling the RektBull Trade Router');
  const selectors = core.decodeAllowedMethodsTerms(byEnforcer('AllowedMethodsEnforcer')).selectors;
  if (selectors.length !== 1 || !eq(selectors[0], SWAP_SELECTOR)) throw new PermissionRefused('it may only allow the router\'s swap');

  const domain = { name: 'DelegationManager', version: '1', chainId, verifyingContract: mm.DelegationManager };
  const value = { delegate: d.delegate, delegator: d.delegator, authority: d.authority, caveats: caveats.map(c => ({ enforcer: c.enforcer, terms: c.terms })), salt: BigInt(d.salt) };
  let signer;
  try { signer = ethers.verifyTypedData(domain, TYPES, value, d.signature); } catch { throw new PermissionRefused('the delegation\'s signature is not valid'); }
  if (!eq(signer, wallet)) throw new PermissionRefused('the delegation was not signed by your wallet');

  const hash = core.hashDelegation({ ...d, salt: BigInt(d.salt), caveats: caveats.map(c => ({ ...c, args: c.args || '0x' })) });
  return { router, expiresAt: beforeThreshold, hash, delegationManager: mm.DelegationManager, delegatorImpl: mm.EIP7702StatelessDeleGatorImpl };
}

/** Onchain: the wallet is a MetaMask EIP-7702 account and has live limits on the router. */
async function checkOnchain({ chainId, wallet, router, delegatorImpl, now = Math.floor(Date.now() / 1000) }) {
  const chain = chainName(chainId);
  const code = String(await evmRpc(chain, 'eth_getCode', [wallet, 'latest'])).toLowerCase();
  if (code !== ('0xef0100' + delegatorImpl.slice(2)).toLowerCase()) {
    throw new PermissionRefused('your wallet is not yet a MetaMask smart account on this chain: switch it on in MetaMask first');
  }
  const raw = await evmRpc(chain, 'eth_call', [{ to: router, data: ROUTER.encodeFunctionData('limits', [wallet]) }, 'latest']);
  const l = ROUTER.decodeFunctionResult('limits', raw);
  if (!(Number(l.validUntil) > now)) throw new PermissionRefused('set your trading limits on the router first');
  return { perTradeUsd: Number(l.perTradeUsd) / 1e8, perPeriodUsd: Number(l.perPeriodUsd) / 1e8, periodSeconds: Number(l.periodSeconds), validUntil: Number(l.validUntil) };
}

async function view(chain, to, iface, fn, args) {
  const raw = await evmRpc(chain, 'eth_call', [{ to, data: iface.encodeFunctionData(fn, args) }, 'latest']);
  return iface.decodeFunctionResult(fn, raw);
}

async function routerLimits(chainId, router, wallet, now = Math.floor(Date.now() / 1000)) {
  const l = await view(chainName(chainId), router, ROUTER, 'limits', [wallet]);
  if (!(Number(l.validUntil) > now)) throw new PermissionRefused('set your trading limits on the router first');
  return { perTradeUsd: Number(l.perTradeUsd) / 1e8, perPeriodUsd: Number(l.perPeriodUsd) / 1e8, periodSeconds: Number(l.periodSeconds), validUntil: Number(l.validUntil) };
}

/** A Safe: the signed-in wallet owns it; the module is on, names RektBull's key, and limits are set. */
async function checkSafe({ chainId, owner, safe, sessionKey, now = Math.floor(Date.now() / 1000) }) {
  const net = networks.network(chainId);
  if (!net.safeModule) throw new PermissionRefused('Safe trading isn\'t available on this network yet');
  if (!ethers.isAddress(safe)) throw new PermissionRefused('safe must be the Safe\'s address');
  const chain = chainName(chainId);
  let isOwner;
  try { [isOwner] = await view(chain, safe, SAFE, 'isOwner', [owner]); } catch { throw new PermissionRefused('that address is not a Safe on this network'); }
  if (!isOwner) throw new PermissionRefused('your signed-in wallet is not an owner of that Safe');
  const [enabled] = await view(chain, safe, SAFE, 'isModuleEnabled', [net.safeModule]);
  if (!enabled) throw new PermissionRefused('enable the RektBull Safe Module on your Safe first');
  const session = await view(chain, net.safeModule, MODULE, 'sessions', [safe]);
  if (!eq(session.key, sessionKey)) throw new PermissionRefused('your Safe\'s session on the module must name RektBull\'s session key');
  if (!(Number(session.validUntil) > now)) throw new PermissionRefused('your Safe\'s session on the module has expired');
  const limits = await routerLimits(chainId, net.router, safe, now);
  return { router: net.router, limits, expiresAt: Math.min(Number(session.validUntil), limits.validUntil), hash: ethers.id(`safe:${chainId}:${safe.toLowerCase()}:${Number(session.validUntil)}`) };
}

/** A Coinbase Smart Wallet: its spend permissions go to the router only, are live, and it named RektBull's key as operator. */
async function checkCoinbase({ chainId, wallet, permissions, sessionKey, now = Math.floor(Date.now() / 1000) }) {
  const net = networks.network(chainId);
  if (!net.spendPermissionManager) throw new PermissionRefused('Coinbase Smart Wallet trading isn\'t available on this network yet');
  if (!Array.isArray(permissions) || !permissions.length) throw new PermissionRefused('spend_permissions must list at least one spend permission');
  const chain = chainName(chainId);
  let ends = Infinity;
  const tokens = new Set();
  for (const p of permissions) {
    if (!eq(p.account, wallet)) throw new PermissionRefused('every spend permission must be from your signed-in wallet');
    if (!eq(p.spender, net.router)) throw new PermissionRefused('spend permissions may only name the RektBull Trade Router as spender');
    if (!networks.routerToken(net, p.token)) throw new PermissionRefused(`the router doesn't trade ${p.token}`);
    if (tokens.has(String(p.token).toLowerCase())) throw new PermissionRefused('one spend permission per token');
    tokens.add(String(p.token).toLowerCase());
    if (!(Number(p.end) > now)) throw new PermissionRefused('a spend permission has already ended');
    const tuple = [p.account, p.spender, p.token, BigInt(p.allowance), Number(p.period), Number(p.start), Number(p.end), BigInt(p.salt), p.extraData || '0x'];
    const [approved] = await view(chain, net.spendPermissionManager, SPM, 'isApproved', [tuple]);
    const [revoked] = await view(chain, net.spendPermissionManager, SPM, 'isRevoked', [tuple]);
    if (!approved || revoked) throw new PermissionRefused('a spend permission is not approved with Coinbase, or was revoked');
    ends = Math.min(ends, Number(p.end));
  }
  const [operator] = await view(chain, net.router, ROUTER, 'operatorOf', [wallet]);
  if (!eq(operator, sessionKey)) throw new PermissionRefused('name RektBull\'s session key as your operator on the router first');
  const limits = await routerLimits(chainId, net.router, wallet, now);
  const hash = ethers.id(`coinbase:${chainId}:${wallet.toLowerCase()}:${JSON.stringify(permissions.map(p => [p.token, String(p.salt), Number(p.end)]))}`);
  return { router: net.router, limits, expiresAt: Math.min(ends, limits.validUntil), hash };
}

async function register(account, body, { sessionKey, onchain = checkOnchain } = {}) {
  const chainId = Number(body.chain_id);
  const walletType = body.wallet_type || 'metamask';
  let tradingWallet;
  let stored;
  let c;
  if (walletType === 'metamask') {
    c = checkDelegation({ delegation: body.delegation, chainId, wallet: account.wallet, sessionKey });
    c.limits = await onchain({ chainId, wallet: account.wallet, router: c.router, delegatorImpl: c.delegatorImpl });
    tradingWallet = account.wallet;
    stored = body.delegation;
  } else if (walletType === 'safe') {
    c = await checkSafe({ chainId, owner: account.wallet, safe: body.safe, sessionKey });
    tradingWallet = String(body.safe).toLowerCase();
    stored = { safe: tradingWallet };
  } else if (walletType === 'coinbase') {
    c = await checkCoinbase({ chainId, wallet: account.wallet, permissions: body.spend_permissions, sessionKey });
    tradingWallet = account.wallet;
    stored = { spend_permissions: body.spend_permissions };
  } else {
    throw new PermissionRefused(`${walletType} wallets can trade approve-each for now; automatic trading for them comes later`);
  }
  const id = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO trade_permissions (id, account_id, wallet, chain_id, wallet_type, router, delegate, delegation, delegation_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10))
     ON CONFLICT (delegation_hash) DO UPDATE SET status = trade_permissions.status RETURNING *`,
    [id, account.id, tradingWallet, chainId, walletType, c.router, sessionKey.toLowerCase(), JSON.stringify(stored), c.hash, c.expiresAt],
  );
  return { ...present(rows[0]), limits: c.limits };
}

function present(r) {
  return { id: r.id, chain_id: r.chain_id, wallet_type: r.wallet_type, wallet: r.wallet, router: r.router, status: r.status, expires_at: r.expires_at, created_at: r.created_at, revoked_at: r.revoked_at };
}

async function list(account) {
  await db.query(`UPDATE trade_permissions SET status = 'expired' WHERE account_id = $1 AND status = 'active' AND expires_at <= now()`, [account.id]);
  const { rows } = await db.query('SELECT * FROM trade_permissions WHERE account_id = $1 ORDER BY created_at DESC', [account.id]);
  return rows.map(present);
}

/** "Stop trading": RektBull stops using it at once. The onchain revoke is the user's own transaction. */
async function revoke(account, id) {
  const { rows } = await db.query(
    `UPDATE trade_permissions SET status = 'revoked', revoked_at = now() WHERE id = $1 AND account_id = $2 AND status = 'active' RETURNING *`,
    [id, account.id],
  );
  if (!rows.length) throw Object.assign(new Error('no active permission with that id'), { status: 404 });
  return present(rows[0]);
}

module.exports = { checkDelegation, checkOnchain, checkSafe, checkCoinbase, register, list, revoke, PermissionRefused, SWAP_SELECTOR, TYPES, chainName, ROUTER };

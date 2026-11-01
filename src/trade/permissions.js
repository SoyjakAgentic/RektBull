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
 * Wallet types: MetaMask first. Safe and Coinbase Smart Wallet need their own
 * adapters and break-it tests (milestone 3); Phantom comes with Solana.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const core = require('@metamask/delegation-core');
const { DELEGATOR_CONTRACTS } = require('@metamask/delegation-deployments');
const db = require('../config/db');
const env = require('../config/env');
const { evmRpc } = require('../providers/rpc');

const MM_VERSION = '1.3.0';
const MAX_DAYS = 30;
const SWAP_SELECTOR = ethers.id('swap((address,address,uint256,uint256,address,address,bytes,uint256))').slice(0, 10);
const ROUTER = new ethers.Interface(['function limits(address) view returns (uint128 perTradeUsd, uint128 perPeriodUsd, uint32 periodSeconds, uint64 validUntil)']);

/** chainId -> RPC chain name, for the chains with a deployed Trade Router. */
const CHAIN_NAMES = { 84532: 'base-sepolia', 8453: 'base' };

class PermissionRefused extends Error {
  constructor(message) { super(message); this.status = 422; }
}

function routerFor(chainId) {
  const router = env.tradeRouters[String(chainId)];
  if (!router) throw new PermissionRefused(`automatic trading isn't available on chain ${chainId} yet`);
  return router.toLowerCase();
}

function mmContracts(chainId) {
  const c = DELEGATOR_CONTRACTS[MM_VERSION]?.[chainId];
  if (!c) throw new PermissionRefused(`MetaMask's delegation contracts aren't deployed on chain ${chainId}`);
  return c;
}

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
  const chain = CHAIN_NAMES[chainId];
  const code = String(await evmRpc(chain, 'eth_getCode', [wallet, 'latest'])).toLowerCase();
  if (code !== ('0xef0100' + delegatorImpl.slice(2)).toLowerCase()) {
    throw new PermissionRefused('your wallet is not yet a MetaMask smart account on this chain: switch it on in MetaMask first');
  }
  const raw = await evmRpc(chain, 'eth_call', [{ to: router, data: ROUTER.encodeFunctionData('limits', [wallet]) }, 'latest']);
  const l = ROUTER.decodeFunctionResult('limits', raw);
  if (!(Number(l.validUntil) > now)) throw new PermissionRefused('set your trading limits on the router first');
  return { perTradeUsd: Number(l.perTradeUsd) / 1e8, perPeriodUsd: Number(l.perPeriodUsd) / 1e8, periodSeconds: Number(l.periodSeconds), validUntil: Number(l.validUntil) };
}

async function register(account, { chain_id: chainId, wallet_type: walletType = 'metamask', delegation }, { sessionKey, onchain = checkOnchain } = {}) {
  chainId = Number(chainId);
  if (walletType !== 'metamask') throw new PermissionRefused(`${walletType} wallets can trade approve-each for now; automatic trading for them comes later`);
  const c = checkDelegation({ delegation, chainId, wallet: account.wallet, sessionKey });
  const limits = await onchain({ chainId, wallet: account.wallet, router: c.router, delegatorImpl: c.delegatorImpl });
  const id = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO trade_permissions (id, account_id, wallet, chain_id, wallet_type, router, delegate, delegation, delegation_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10))
     ON CONFLICT (delegation_hash) DO UPDATE SET status = trade_permissions.status RETURNING *`,
    [id, account.id, account.wallet, chainId, walletType, c.router, sessionKey.toLowerCase(), JSON.stringify(delegation), c.hash, c.expiresAt],
  );
  return { ...present(rows[0]), limits };
}

function present(r) {
  return { id: r.id, chain_id: r.chain_id, wallet_type: r.wallet_type, router: r.router, status: r.status, expires_at: r.expires_at, created_at: r.created_at, revoked_at: r.revoked_at };
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

module.exports = { checkDelegation, checkOnchain, register, list, revoke, PermissionRefused, SWAP_SELECTOR, TYPES, CHAIN_NAMES };

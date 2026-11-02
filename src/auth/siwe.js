/**
 * Sign in with your wallet (EIP-4361, "Sign-In with Ethereum").
 *
 * The server writes the whole message and stores it; the wallet signs that
 * exact text, and the server checks the signature against what it stored.
 * Nothing the client sends back is parsed, so a tampered message can't get
 * through: it simply won't match.
 *
 * Plain wallets (EOAs) sign with their key. Smart-contract wallets that are
 * already deployed (a Coinbase Smart Wallet, a MetaMask smart account) are
 * checked onchain with EIP-1271's isValidSignature, on the chain named in the
 * message; ones not deployed yet (a new Coinbase Smart Wallet) with EIP-6492
 * (see erc6492.js). A Safe is linked by one of its owners instead, who signs in with
 * their own wallet (trade/permissions.js checks they own the Safe).
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const db = require('../config/db');
const erc6492 = require('./erc6492');

const CHALLENGE_MINUTES = 10;
const SESSION_DAYS = 7;

function buildMessage({ address, chainId = 1, nonce, issuedAt, expiresAt, domain = env.siweDomain, uri = env.siweUri }) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    ethers.getAddress(address),
    '',
    'Sign in to RektBull. This signature only proves you own this wallet: it does not move funds or approve anything.',
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
  ].join('\n');
}

/** True when signature is wallet's signature of message. */
function signedBy(message, signature, wallet) {
  try {
    return ethers.verifyMessage(message, signature).toLowerCase() === String(wallet).toLowerCase();
  } catch {
    return false;
  }
}

const ERC1271 = new ethers.Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
const ERC1271_MAGIC = '0x1626ba7e';
/** Chain ids RektBull can check a smart-wallet signature on, and their RPC names. */
const SIGNIN_CHAINS = { 1: 'ethereum', 8453: 'base', 84532: 'base-sepolia', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon', 56: 'bsc' };

/**
 * True when the smart wallet accepts signature for message, on the message's
 * chain: EIP-1271 if it's deployed, EIP-6492 if it isn't yet (a new Coinbase
 * Smart Wallet). Both are read-only calls.
 */
async function signedByContract(message, signature, wallet) {
  const chainId = Number(/\nChain ID: (\d+)\n/.exec(message)?.[1]);
  const chain = SIGNIN_CHAINS[chainId];
  if (!chain) return false;
  const { evmRpc } = require('../providers/rpc');
  const hash = ethers.hashMessage(message);
  const wrapped = erc6492.isWrapped(signature) ? erc6492.unwrap(signature) : null;
  if (erc6492.isWrapped(signature) && !wrapped) return false;
  try {
    const code = await evmRpc(chain, 'eth_getCode', [wallet, 'latest']);
    const deployed = code && code !== '0x';
    if (!deployed) {
      if (!wrapped) return false;
      const raw = await evmRpc(chain, 'eth_call', [{ data: erc6492.checkCallData(wallet, hash, wrapped) }, 'latest']);
      return String(raw).toLowerCase() === '0x01';
    }
    // Deployed since it signed: its wrapper is no longer needed; check the signature inside.
    const sig = wrapped ? wrapped.signature : signature;
    const raw = await evmRpc(chain, 'eth_call', [{ to: wallet, data: ERC1271.encodeFunctionData('isValidSignature', [hash, sig]) }, 'latest']);
    return String(raw).slice(0, 10).toLowerCase() === ERC1271_MAGIC;
  } catch {
    return false;
  }
}

async function createChallenge({ address, chainId }) {
  if (!ethers.isAddress(address)) throw Object.assign(new Error('address must be a wallet address'), { status: 400 });
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_MINUTES * 60 * 1000);
  const id = crypto.randomUUID();
  const message = buildMessage({ address, chainId: Number(chainId) || 1, nonce: crypto.randomBytes(12).toString('hex'), issuedAt: now, expiresAt });
  await db.query('INSERT INTO siwe_challenges (id, wallet, message, expires_at) VALUES ($1, $2, $3, $4)', [id, address.toLowerCase(), message, expiresAt]);
  return { challenge_id: id, message, expires_at: expiresAt.toISOString() };
}

function issueToken(account) {
  if (!env.jwtSecret) throw new Error('JWT_SECRET is not set');
  return jwt.sign({ sub: String(account.id), wallet: account.wallet }, env.jwtSecret, { expiresIn: `${SESSION_DAYS}d` });
}

/** Checks the signature, uses the challenge up, and returns a session token. */
async function verifyChallenge({ challengeId, signature }) {
  const bad = () => Object.assign(new Error('The signature does not match this sign-in request'), { status: 401 });
  return db.tx(async c => {
    const { rows } = await c.query('SELECT * FROM siwe_challenges WHERE id = $1 FOR UPDATE', [challengeId]);
    const ch = rows[0];
    if (!ch || ch.used_at || new Date(ch.expires_at) <= new Date()) throw Object.assign(new Error('This sign-in request has expired; start again'), { status: 401 });
    if (!signedBy(ch.message, signature, ch.wallet) && !(await signedByContract(ch.message, signature, ch.wallet))) throw bad();
    await c.query('UPDATE siwe_challenges SET used_at = now() WHERE id = $1', [challengeId]);
    const acct = await c.query(
      `INSERT INTO accounts (wallet) VALUES ($1) ON CONFLICT (wallet) DO UPDATE SET wallet = EXCLUDED.wallet RETURNING id, wallet`,
      [ch.wallet],
    );
    const account = acct.rows[0];
    return { token: issueToken(account), account: { id: account.id, wallet: account.wallet } };
  });
}

function readToken(token) {
  if (!env.jwtSecret) return null;
  try {
    const p = jwt.verify(token, env.jwtSecret);
    return { id: Number(p.sub), wallet: p.wallet, ...(p.scope ? { scope: p.scope, jti: p.jti } : {}) };
  } catch {
    return null;
  }
}

module.exports = { buildMessage, signedBy, signedByContract, createChallenge, verifyChallenge, readToken, issueToken };

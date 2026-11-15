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
 *
 * Solana wallets sign in the same way (siws.js). An account has an EVM wallet,
 * a Solana wallet, or both: it signs in with either, and links the other by
 * signing a link message with it while signed in. Accounts are never merged.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const db = require('../config/db');
const erc6492 = require('./erc6492');
const siws = require('./siws');
const base58 = require('../lib/base58');

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

const challengeError = msg => Object.assign(new Error(msg), { status: 400 });
const KINDS = ['evm', 'solana'];
/** The account's column for a kind of wallet. */
const COLUMN = { evm: 'wallet', solana: 'solana_wallet' };

/**
 * A message to sign: to sign in (no linkAccountId) or to link this wallet to
 * that signed-in account. kind 'evm' (Sign-In with Ethereum) or 'solana'.
 */
async function createChallenge({ address, chainId, kind = 'evm', linkAccountId = null }) {
  if (!KINDS.includes(kind)) throw challengeError("kind must be 'evm' or 'solana'");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_MINUTES * 60 * 1000);
  const id = crypto.randomUUID();
  const nonce = crypto.randomBytes(12).toString('hex');
  let message, wallet;
  if (kind === 'solana') {
    if (!base58.isSolanaAddress(address)) throw challengeError('address must be a Solana wallet address');
    wallet = address;
    message = siws.buildMessage({ address, nonce, issuedAt: now, expiresAt, statement: linkAccountId ? siws.STATEMENTS.link : siws.STATEMENTS.signIn });
  } else {
    if (!ethers.isAddress(address)) throw challengeError('address must be a wallet address');
    wallet = address.toLowerCase();
    message = buildMessage({ address, chainId: Number(chainId) || 1, nonce, issuedAt: now, expiresAt });
    if (linkAccountId) message = message.replace('Sign in to RektBull.', 'Link this wallet to your RektBull account.');
  }
  await db.query('INSERT INTO siwe_challenges (id, wallet, message, expires_at, kind, link_account_id) VALUES ($1, $2, $3, $4, $5, $6)', [id, wallet, message, expiresAt, kind, linkAccountId]);
  return { challenge_id: id, kind, message, expires_at: expiresAt.toISOString() };
}

const present = a => ({ id: a.id, wallet: a.wallet || null, solana_wallet: a.solana_wallet || null });

function issueToken(account) {
  if (!env.jwtSecret) throw new Error('JWT_SECRET is not set');
  return jwt.sign({ sub: String(account.id), wallet: account.wallet || null, ...(account.solana_wallet ? { sol: account.solana_wallet } : {}) }, env.jwtSecret, { expiresIn: `${SESSION_DAYS}d` });
}

const blocked = async a => {
  const settings = require('../admin/settings');
  for (const w of [a.wallet, a.solana_wallet].filter(Boolean)) if (await settings.read(`blocked:${String(w).toLowerCase()}`)) return true;
  return false;
};

/** Locks the challenge, checks it's live and of the right purpose, and checks the signature. */
async function useChallenge(c, challengeId, linkAccountId, sig) {
  const { rows } = await c.query('SELECT * FROM siwe_challenges WHERE id = $1 FOR UPDATE', [challengeId]);
  const ch = rows[0];
  const expired = Object.assign(new Error(linkAccountId ? 'This link request has expired; start again' : 'This sign-in request has expired; start again'), { status: 401 });
  if (!ch || ch.used_at || new Date(ch.expires_at) <= new Date()) throw expired;
  // A sign-in challenge can't link a wallet, and a link challenge is only for the account that asked for it.
  if (String(ch.link_account_id || '') !== String(linkAccountId || '')) throw expired;
  const ok = ch.kind === 'solana'
    ? siws.signedBy(ch.message, sig, ch.wallet)
    : signedBy(ch.message, sig, ch.wallet) || await signedByContract(ch.message, sig, ch.wallet);
  if (!ok) throw Object.assign(new Error('The signature does not match this request'), { status: 401 });
  await c.query('UPDATE siwe_challenges SET used_at = now() WHERE id = $1', [challengeId]);
  return ch;
}

/** Checks the signature, uses the challenge up, and returns a session token. */
async function verifyChallenge({ challengeId, signature: sig }) {
  return db.tx(async c => {
    const ch = await useChallenge(c, challengeId, null, sig);
    const col = COLUMN[ch.kind];
    const { rows: [account] } = await c.query(
      `INSERT INTO accounts (${col}) VALUES ($1) ON CONFLICT (${col}) DO UPDATE SET ${col} = EXCLUDED.${col} RETURNING id, wallet, solana_wallet`,
      [ch.wallet],
    );
    // Blocking either of an account's wallets blocks the account.
    if (await blocked(account)) throw Object.assign(new Error('This wallet can\'t sign in to RektBull.'), { status: 403 });
    return { token: issueToken(account), account: present(account) };
  });
}

/**
 * Links the wallet that signed the link challenge to the signed-in account.
 * Refused if the account already has another wallet of that kind, or the
 * wallet is another account's (accounts aren't merged: sign in with it instead).
 */
async function linkWallet({ accountId, challengeId, signature: sig }) {
  return db.tx(async c => {
    const ch = await useChallenge(c, challengeId, accountId, sig);
    const col = COLUMN[ch.kind];
    const { rows: [me] } = await c.query('SELECT id, wallet, solana_wallet FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (!me) throw Object.assign(new Error('No such account'), { status: 404 });
    const label = ch.kind === 'solana' ? 'Solana' : 'EVM';
    if (me[col] === ch.wallet) return { token: issueToken(me), account: present(me), already_linked: true };
    if (me[col]) throw Object.assign(new Error(`This account already has a ${label} wallet (${me[col]}). Unlink it first to link another.`), { status: 409, code: 'already_linked' });
    const { rows: other } = await c.query(`SELECT id FROM accounts WHERE ${col} = $1`, [ch.wallet]);
    if (other.length) throw Object.assign(new Error(`That wallet already has its own RektBull account. Sign in with it to use that account; accounts aren't merged.`), { status: 409, code: 'wallet_has_account' });
    if (await blocked({ [col]: ch.wallet })) throw Object.assign(new Error('This wallet can\'t be used on RektBull.'), { status: 403 });
    const { rows: [account] } = await c.query(`UPDATE accounts SET ${col} = $2 WHERE id = $1 RETURNING id, wallet, solana_wallet`, [accountId, ch.wallet]);
    return { token: issueToken(account), account: present(account) };
  });
}

/** Removes the account's wallet of one kind; refused when it's the only wallet the account has. */
async function unlinkWallet({ accountId, kind }) {
  if (!KINDS.includes(kind)) throw challengeError("kind must be 'evm' or 'solana'");
  return db.tx(async c => {
    const { rows: [me] } = await c.query('SELECT id, wallet, solana_wallet FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (!me) throw Object.assign(new Error('No such account'), { status: 404 });
    const col = COLUMN[kind];
    const other = COLUMN[kind === 'evm' ? 'solana' : 'evm'];
    if (!me[col]) return { token: issueToken(me), account: present(me) };
    if (!me[other]) throw Object.assign(new Error('This is the only wallet on the account, so it can\'t be unlinked: it\'s how you sign in.'), { status: 409, code: 'only_wallet' });
    const { rows: [account] } = await c.query(`UPDATE accounts SET ${col} = NULL WHERE id = $1 RETURNING id, wallet, solana_wallet`, [accountId]);
    return { token: issueToken(account), account: present(account) };
  });
}

/** The account's wallets as stored now (a token can be older than a link or unlink). */
async function wallets(accountId) {
  const { rows: [a] } = await db.query('SELECT id, wallet, solana_wallet FROM accounts WHERE id = $1', [accountId]);
  return a ? present(a) : null;
}

function readToken(token) {
  if (!env.jwtSecret) return null;
  try {
    const p = jwt.verify(token, env.jwtSecret);
    return { id: Number(p.sub), wallet: p.wallet || null, solana_wallet: p.sol || null, iat: p.iat, ...(p.scope ? { scope: p.scope, jti: p.jti } : {}) };
  } catch {
    return null;
  }
}

module.exports = { buildMessage, signedBy, signedByContract, createChallenge, verifyChallenge, linkWallet, unlinkWallet, wallets, readToken, issueToken };

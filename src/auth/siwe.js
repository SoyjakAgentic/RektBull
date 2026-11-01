/**
 * Sign in with your wallet (EIP-4361, "Sign-In with Ethereum").
 *
 * The server writes the whole message and stores it; the wallet signs that
 * exact text, and the server checks the signature against what it stored.
 * Nothing the client sends back is parsed, so a tampered message can't get
 * through: it simply won't match.
 *
 * Plain wallets (EOAs) only for now. Smart-contract wallets sign with
 * EIP-1271, which needs an onchain check; see docs/SCOPE.md.
 */
const crypto = require('crypto');
const { ethers } = require('ethers');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const db = require('../config/db');

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
    if (!signedBy(ch.message, signature, ch.wallet)) throw bad();
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
    return { id: Number(p.sub), wallet: p.wallet };
  } catch {
    return null;
  }
}

module.exports = { buildMessage, signedBy, createChallenge, verifyChallenge, readToken, issueToken };

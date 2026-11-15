/**
 * Sign in with a Solana wallet ("Sign In With Solana", the same message shape
 * as Sign-In with Ethereum, chain id `mainnet`). Phantom, Solflare and
 * MetaMask's Solana account all sign plain text with `signMessage`; the
 * signature is Ed25519 over the message's UTF-8 bytes, checked here with
 * Node's own crypto: nothing is sent anywhere.
 *
 * As with EVM sign-in, the server writes the whole message and stores it;
 * only a signature of that exact text is accepted.
 */
const crypto = require('crypto');
const env = require('../config/env');
const base58 = require('../lib/base58');

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex'); // the DER prefix of a raw 32-byte Ed25519 public key

const STATEMENTS = {
  signIn: 'Sign in to RektBull. This signature only proves you own this wallet: it does not move funds or approve anything.',
  link: 'Link this wallet to your RektBull account. This signature only proves you own this wallet: it does not move funds or approve anything.',
};

function buildMessage({ address, nonce, issuedAt, expiresAt, statement = STATEMENTS.signIn, domain = env.siweDomain, uri = env.siweUri }) {
  return [
    `${domain} wants you to sign in with your Solana account:`,
    address,
    '',
    statement,
    '',
    `URI: ${uri}`,
    'Version: 1',
    'Chain ID: mainnet',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
  ].join('\n');
}

/** The 64 signature bytes, from base64 (as browsers send it) or base58 (as Solana tools print it); null if neither. */
function signatureBytes(signature) {
  const s = String(signature || '').trim();
  try {
    // 64 bytes in base64 always end in "==", which base58 never contains.
    const b = /[+/=]/.test(s) ? Buffer.from(s, 'base64') : base58.decode(s);
    return b.length === 64 ? b : null;
  } catch {
    return null;
  }
}

/** True when signature is the Solana wallet's Ed25519 signature of message. */
function signedBy(message, signature, wallet) {
  if (!base58.isSolanaAddress(wallet)) return false;
  const sig = signatureBytes(signature);
  if (!sig) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, base58.decode(wallet)]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

module.exports = { buildMessage, signedBy, signatureBytes, STATEMENTS };

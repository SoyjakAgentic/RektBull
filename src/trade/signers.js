/**
 * RektBull's session key: the only key that may use users' trading
 * permissions. In production it lives in Google Cloud KMS (KMS_SESSION_KEY_VERSION)
 * and only the trade service can use it.
 *
 * On test networks only, DEV_SESSION_KEY (a throwaway private key) may stand
 * in for KMS. It is refused in production, and refused for any chain that
 * isn't a known test network, so a stray dev key can never trade real funds.
 *
 * Every signature is written to key_signatures first, so each one in KMS's
 * audit log can be matched to a trade.
 *
 * The session key also pays the gas for the trades it sends: MetaMask's
 * Redeemer rule means it must be the account that submits the transaction.
 */
const { ethers } = require('ethers');
const env = require('../config/env');
const db = require('../config/db');
const { KmsSigner } = require('./kmsSigner');

const TESTNETS = new Set([84532, 11155111, 31337]);

class SignerRefused extends Error {}

/** Logs a signature before it's made: KMS audit logs are matched against these rows. */
async function logSignature(signer, digest, purpose) {
  if (!env.databaseUrl) return;
  await db.query('INSERT INTO key_signatures (signer, digest, purpose) VALUES ($1, $2, $3)', [signer.toLowerCase(), digest, purpose]);
}

/** An ethers signer for the session key on chainId, connected to provider. */
async function sessionSigner(chainId, provider) {
  let signer;
  if (env.kmsSessionKeyVersion) {
    signer = new KmsSigner({ keyVersion: env.kmsSessionKeyVersion }, provider);
  } else if (env.devSessionKey) {
    if (env.nodeEnv === 'production') throw new SignerRefused('DEV_SESSION_KEY is refused in production: use KMS_SESSION_KEY_VERSION');
    if (!TESTNETS.has(Number(chainId))) throw new SignerRefused(`DEV_SESSION_KEY may only sign on test networks, not chain ${chainId}`);
    signer = new ethers.Wallet(env.devSessionKey, provider);
  } else {
    throw new SignerRefused('no session key configured (KMS_SESSION_KEY_VERSION, or DEV_SESSION_KEY on a test network)');
  }
  const address = (await signer.getAddress()).toLowerCase();
  if (env.sessionKeyAddress && address !== env.sessionKeyAddress) {
    throw new SignerRefused(`the session key is ${address}, but SESSION_KEY_ADDRESS says ${env.sessionKeyAddress}: users' permissions name the latter`);
  }
  return signer;
}

module.exports = { sessionSigner, logSignature, SignerRefused, TESTNETS };

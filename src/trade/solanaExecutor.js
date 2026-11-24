/**
 * The executor of Solana orders: the one key the user names in each order
 * (docs/SOLANA_ORDERS.md). The order program lets it do one thing: fill that
 * user's order, at the user's own price or better, inside the order's window,
 * with the output going only to the user. It can't take anything.
 *
 * In production it lives in Google Cloud KMS as an Ed25519 key
 * (EC_SIGN_ED25519, KMS_SOLANA_EXECUTOR_KEY_VERSION), used only by the trade
 * service, whose service account alone has roles/cloudkms.signer on it. KMS
 * signs the transaction's message bytes as given (Ed25519 signs the message,
 * not a digest). Every signature is written to key_signatures first, so each
 * one in KMS's audit log can be matched to a fill.
 *
 * Off mainnet only, DEV_SOLANA_EXECUTOR_KEY (a throwaway 32-byte seed, base58
 * or hex) may stand in for KMS: it is refused in production, and refused
 * whenever the RPC's chain is Solana mainnet (by its genesis hash).
 *
 * The executor also pays each fill's network fee and the rent of transit's
 * token accounts, which the program returns to it when it closes them.
 */
const crypto = require('crypto');
const env = require('../config/env');
const db = require('../config/db');
const { encode: b58encode, decode: b58decode } = require('../lib/base58');

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

class ExecutorRefused extends Error {}

/** An Ed25519 public key object from its 32 bytes. */
const publicKeyOf = raw => crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' });

/** A signer from a 32-byte seed (tests and the dev key): { address, sign(message) }. */
function fromSeed(seed) {
  const s = Buffer.from(seed);
  if (s.length !== 32) throw new ExecutorRefused('the executor seed must be 32 bytes');
  const priv = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, s]), format: 'der', type: 'pkcs8' });
  const raw = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { address: b58encode(raw), sign: async message => crypto.sign(null, Buffer.from(message), priv) };
}

/** The KMS key as a signer. `client` is a KeyManagementServiceClient (tests pass a fake). */
async function fromKms(keyVersion, client = new (require('@google-cloud/kms').KeyManagementServiceClient)()) {
  const [pub] = await client.getPublicKey({ name: keyVersion });
  if (pub.algorithm && pub.algorithm !== 'EC_SIGN_ED25519') throw new ExecutorRefused(`the KMS key is ${pub.algorithm}, not EC_SIGN_ED25519`);
  const der = Buffer.from(String(pub.pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) throw new ExecutorRefused('the KMS key is not an Ed25519 public key');
  const raw = der.subarray(12);
  const key = publicKeyOf(raw);
  return {
    address: b58encode(raw),
    async sign(message) {
      const [res] = await client.asymmetricSign({ name: keyVersion, data: Buffer.from(message) });
      if (res.verifiedDataCrc32c === false) throw new Error('KMS did not receive the message intact');
      if (res.name && res.name !== keyVersion) throw new Error('KMS signed with a different key version');
      const sig = Buffer.from(res.signature);
      // Checked here, before anything is sent: a wrong signature would only waste a send.
      if (sig.length !== 64 || !crypto.verify(null, Buffer.from(message), key, sig)) throw new Error('KMS returned a signature that doesn\'t verify for this key');
      return sig;
    },
  };
}

/** A dev seed from base58 or hex. */
function seedOf(s) {
  const t = String(s).trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  const b = Buffer.from(b58decode(t));
  return b.length === 64 ? b.subarray(0, 32) : b; // a 64-byte Solana secret key starts with its seed
}

let cached = null;

/**
 * The executor: { address, sign(messageBytes) → 64-byte signature }. Checks
 * that it is the address orders name (SOLANA_ORDERS_EXECUTOR), and logs each
 * signature before it is made.
 */
async function executor({ rpc = require('../providers/rpc') } = {}) {
  if (!cached) {
    let signer;
    if (env.kmsSolanaExecutorKeyVersion) {
      signer = await fromKms(env.kmsSolanaExecutorKeyVersion);
    } else if (env.devSolanaExecutorKey) {
      if (env.nodeEnv === 'production') throw new ExecutorRefused('DEV_SOLANA_EXECUTOR_KEY is refused in production: use KMS_SOLANA_EXECUTOR_KEY_VERSION');
      const genesis = await rpc.solanaRpc('getGenesisHash', []);
      if (!genesis || genesis === MAINNET_GENESIS) throw new ExecutorRefused('DEV_SOLANA_EXECUTOR_KEY may only sign off mainnet (devnet or a local validator)');
      signer = fromSeed(seedOf(env.devSolanaExecutorKey));
    } else {
      throw new ExecutorRefused('no executor key is set (KMS_SOLANA_EXECUTOR_KEY_VERSION, or DEV_SOLANA_EXECUTOR_KEY off mainnet)');
    }
    if (env.solanaOrdersExecutor && signer.address !== env.solanaOrdersExecutor) {
      throw new ExecutorRefused(`the executor key is ${signer.address}, but SOLANA_ORDERS_EXECUTOR says ${env.solanaOrdersExecutor}: users' orders name the latter`);
    }
    cached = signer;
  }
  const s = cached;
  return {
    address: s.address,
    async sign(message, purpose = 'solana_fill') {
      const digest = crypto.createHash('sha256').update(Buffer.from(message)).digest('hex');
      if (env.databaseUrl) await db.query('INSERT INTO key_signatures (signer, digest, purpose) VALUES ($1, $2, $3)', [s.address, `0x${digest}`, purpose]);
      return s.sign(message);
    },
  };
}

module.exports = { executor, fromSeed, fromKms, seedOf, ExecutorRefused, MAINNET_GENESIS, _reset: () => { cached = null; } };

/**
 * RektBull's own keys, held in Google Cloud KMS (HSM, EC_SIGN_SECP256K1_SHA256).
 * The private key never leaves KMS; this asks KMS to sign each digest.
 *
 * Used only by the trade service (SERVICE_ROLE=trade), whose service account
 * is the only one with roles/cloudkms.signer on these keys. Never holds or
 * signs for a user's key: users sign with their own wallets.
 *
 * KMS returns an ASN.1 DER ECDSA signature (r, s) over the digest. Ethereum
 * needs (r, s, v) with s in the lower half of the curve order, so: parse the
 * DER, flip s to n - s when it's high, and find v by recovering the address
 * for each candidate and keeping the one that matches this key.
 */
const { ethers } = require('ethers');

const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const HALF_N = N / 2n;

/** A DER length at buf[at]: { len, next } (short or long form). */
function derLength(buf, at) {
  const first = buf[at];
  if (first === undefined) throw new Error('truncated DER signature');
  if (!(first & 0x80)) return { len: first, next: at + 1 };
  const n = first & 0x7f;
  if (n === 0 || n > 2) throw new Error('bad DER length');
  let len = 0;
  for (let k = 1; k <= n; k++) len = (len << 8) | buf[at + k];
  return { len, next: at + 1 + n };
}

function readInt(buf, at) {
  if (buf[at] !== 0x02) throw new Error('expected a DER INTEGER');
  const { len, next } = derLength(buf, at + 1);
  const bytes = buf.subarray(next, next + len);
  if (bytes.length !== len || len === 0 || len > 33) throw new Error('bad DER INTEGER');
  return { value: BigInt('0x' + bytes.toString('hex')), next: next + len };
}

/** (r, s) from an ASN.1 DER ECDSA signature: SEQUENCE { INTEGER r, INTEGER s }. */
function parseDer(der) {
  const b = Buffer.from(der);
  if (b[0] !== 0x30) throw new Error('not a DER ECDSA signature');
  const { len, next } = derLength(b, 1);
  if (next + len !== b.length) throw new Error('DER signature length mismatch');
  const r = readInt(b, next);
  const s = readInt(b, r.next);
  if (s.next !== b.length) throw new Error('trailing bytes in the DER signature');
  if (r.value === 0n || s.value === 0n || r.value >= N || s.value >= N) throw new Error('DER signature out of range');
  return { r: r.value, s: s.value };
}

/** The address of a secp256k1 public key given as a PEM (SubjectPublicKeyInfo). */
function addressFromPem(pem) {
  const der = Buffer.from(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  const point = der.subarray(der.length - 65);
  if (point[0] !== 0x04) throw new Error('KMS public key is not an uncompressed secp256k1 point');
  return ethers.computeAddress('0x' + point.toString('hex'));
}

/** A 65-byte Ethereum signature from KMS's DER signature over digest, by address. */
function toEthSignature(digest, der, address) {
  let { r, s } = parseDer(der);
  if (s > HALF_N) s = N - s; // Ethereum rejects high-s (EIP-2)
  const rHex = ethers.toBeHex(r, 32);
  const sHex = ethers.toBeHex(s, 32);
  for (const v of [27, 28]) {
    const sig = ethers.Signature.from({ r: rHex, s: sHex, v });
    if (ethers.recoverAddress(digest, sig) === address) return sig;
  }
  throw new Error('KMS signature does not recover to this key\'s address');
}

class KmsSigner extends ethers.AbstractSigner {
  /**
   * @param {object} opts
   * @param {string} opts.keyVersion  projects/…/locations/…/keyRings/…/cryptoKeys/…/cryptoKeyVersions/N
   * @param {object} [opts.client]    a KeyManagementServiceClient (tests pass a fake)
   */
  constructor({ keyVersion, client }, provider = null) {
    super(provider);
    if (!keyVersion) throw new Error('KmsSigner needs a key version name');
    this.keyVersion = keyVersion;
    this.client = client || new (require('@google-cloud/kms').KeyManagementServiceClient)();
    this._address = null;
  }

  connect(provider) {
    const s = new KmsSigner({ keyVersion: this.keyVersion, client: this.client }, provider);
    s._address = this._address;
    return s;
  }

  async getAddress() {
    if (!this._address) {
      const [pub] = await this.client.getPublicKey({ name: this.keyVersion });
      if (pub.algorithm && pub.algorithm !== 'EC_SIGN_SECP256K1_SHA256') throw new Error(`KMS key is ${pub.algorithm}, not EC_SIGN_SECP256K1_SHA256`);
      this._address = addressFromPem(pub.pem);
    }
    return this._address;
  }

  /** Signs a 32-byte digest in KMS. */
  async signDigest(digest) {
    const bytes = ethers.getBytes(digest);
    if (bytes.length !== 32) throw new Error('digest must be 32 bytes');
    // KMS takes the digest in its sha256 field; for Ethereum it's a keccak256 digest, which KMS signs as given.
    const [res] = await this.client.asymmetricSign({ name: this.keyVersion, digest: { sha256: Buffer.from(bytes) } });
    if (res.verifiedDigestCrc32c === false) throw new Error('KMS did not receive the digest intact');
    if (res.name && res.name !== this.keyVersion) throw new Error('KMS signed with a different key version');
    return toEthSignature(digest, res.signature, await this.getAddress());
  }

  async signTransaction(tx) {
    // With a node, fill in nonce, gas and fees; without one, the transaction must be complete.
    const populated = { ...(this.provider ? await this.populateTransaction(tx) : tx) };
    if (populated.from && ethers.getAddress(await ethers.resolveAddress(populated.from)) !== await this.getAddress()) {
      throw new Error('transaction from does not match this KMS key');
    }
    delete populated.from;
    const t = ethers.Transaction.from(populated);
    t.signature = await this.signDigest(t.unsignedHash);
    return t.serialized;
  }

  async signMessage(message) {
    return (await this.signDigest(ethers.hashMessage(message))).serialized;
  }

  async signTypedData(domain, types, value) {
    return (await this.signDigest(ethers.TypedDataEncoder.hash(domain, types, value))).serialized;
  }
}

module.exports = { KmsSigner, parseDer, addressFromPem, toEthSignature, N };

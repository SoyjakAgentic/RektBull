/**
 * Each account gets one deposit address, the same on every EVM chain:
 * child {index} of CRYPTO_DEPOSIT_XPUB, the extended PUBLIC key at
 * m/44'/60'/0'/0 (ported from soyjak-agentic's depositAddress.js).
 *
 * The server never holds a private key. The mnemonic that controls these
 * addresses is made and kept offline, and funds are moved out of them
 * offline too. See docs/PAYMENTS.md.
 */
const { ethers } = require('ethers');
const env = require('../config/env');
const db = require('../config/db');

const EVM_PATH = "m/44'/60'/0'/0";

/** The xpub, checked: public only, at the depth and index of m/44'/60'/0'/0. */
function parseXpub(extendedKey) {
  let node;
  try {
    node = ethers.HDNodeWallet.fromExtendedKey(String(extendedKey).trim());
  } catch {
    throw new Error('CRYPTO_DEPOSIT_XPUB is not an extended public key');
  }
  if (node.privateKey) throw new Error('CRYPTO_DEPOSIT_XPUB holds a private key: set the xpub, never the xprv');
  if (node.depth !== 4 || node.index !== 0) throw new Error(`CRYPTO_DEPOSIT_XPUB is not the key at ${EVM_PATH}`);
  return node;
}

let root = null;
function getRoot() {
  if (root) return root;
  if (!env.depositXpub) throw Object.assign(new Error('Crypto deposits are not set up yet: CRYPTO_DEPOSIT_XPUB is not configured'), { status: 503 });
  root = parseXpub(env.depositXpub);
  return root;
}

const addressAt = (index, node = getRoot()) => node.deriveChild(index).address.toLowerCase();

/** The account's deposit address, giving it an index the first time. */
async function forAccount(accountId) {
  getRoot(); // fail before touching the database if deposits aren't set up
  const { rows } = await db.query(
    `UPDATE accounts SET deposit_index = COALESCE(deposit_index, nextval('deposit_index_seq')) WHERE id = $1 RETURNING deposit_index`,
    [accountId],
  );
  if (!rows.length) throw Object.assign(new Error('account not found'), { status: 404 });
  return addressAt(rows[0].deposit_index);
}

module.exports = { parseXpub, addressAt, forAccount, EVM_PATH };

/**
 * EIP-6492: signatures from smart wallets that aren't deployed yet.
 *
 * A new Coinbase Smart Wallet has an address but no code until its first
 * transaction, so it can't answer EIP-1271. It signs with an EIP-6492 wrapper
 * instead:
 *
 *   abi.encode(factory, factoryCalldata, innerSignature) ++ 0x6492…6492 (32 bytes)
 *
 * We check it with SignInCheck6492 (contracts/contracts/SignInCheck6492.sol):
 * its creation code goes into an eth_call with no `to`, which runs the factory
 * call and then the wallet's isValidSignature inside the call only. Read-only:
 * nothing is sent or deployed.
 */
const { ethers } = require('ethers');
const { bytecode } = require('./signInCheck6492.json');

const SUFFIX = '6492649264926492649264926492649264926492649264926492649264926492';
const coder = ethers.AbiCoder.defaultAbiCoder();

/** True when the signature carries the EIP-6492 wrapper. */
function isWrapped(signature) {
  const s = String(signature || '').toLowerCase();
  return /^0x[0-9a-f]*$/.test(s) && s.length > 2 + 64 && s.endsWith(SUFFIX);
}

/** { factory, factoryCalldata, signature } from a wrapped signature, or null if it can't be decoded. */
function unwrap(signature) {
  if (!isWrapped(signature)) return null;
  try {
    const [factory, factoryCalldata, inner] = coder.decode(['address', 'bytes', 'bytes'], String(signature).slice(0, -64));
    return { factory, factoryCalldata, signature: inner };
  } catch {
    return null;
  }
}

/** The eth_call data that asks SignInCheck6492 whether wallet accepts the wrapped signature for hash. */
function checkCallData(wallet, hash, { factory, factoryCalldata, signature }) {
  return bytecode + coder.encode(['address', 'bytes32', 'address', 'bytes', 'bytes'], [wallet, hash, factory, factoryCalldata, signature]).slice(2);
}

module.exports = { isWrapped, unwrap, checkCallData, SUFFIX };

/**
 * Merkle proofs for airdrop and reward distributors. Every format here
 * hashes pairs sorted (OpenZeppelin's MerkleProof), so a proof is a list of
 * sibling hashes from the leaf up to the root.
 *
 * Leaves:
 *   merkl        keccak256(abi.encode(user, token, amount))          Merkl's Distributor
 *   uniswap      keccak256(abi.encodePacked(index, account, amount))  Uniswap's merkle-distributor and its many copies
 *   oz-standard  keccak256(keccak256(abi.encode(account, amount)))   OpenZeppelin's StandardMerkleTree ([address, uint256])
 */
const { ethers } = require('ethers');

const coder = ethers.AbiCoder.defaultAbiCoder();

function leaf(format, { index, idx, account, token, amount }) {
  index = index ?? idx;
  if (format === 'merkl') return ethers.keccak256(coder.encode(['address', 'address', 'uint256'], [account, token, amount]));
  if (format === 'uniswap') return ethers.solidityPackedKeccak256(['uint256', 'address', 'uint256'], [index, account, amount]);
  if (format === 'oz-standard') return ethers.keccak256(ethers.keccak256(coder.encode(['address', 'uint256'], [account, amount])));
  throw new Error(`unknown Merkle format ${format}`);
}

const hashPair = (a, b) => (BigInt(a) < BigInt(b) ? ethers.keccak256(ethers.concat([a, b])) : ethers.keccak256(ethers.concat([b, a])));

/** The root a leaf and its proof lead to. */
function rootOf(leafHash, proof) {
  let h = leafHash;
  for (const s of proof) h = hashPair(h, s);
  return h;
}

const sameHash = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

function verify(format, entry, proof, root) {
  try { return sameHash(rootOf(leaf(format, entry), proof), root); } catch { return false; }
}

/** OpenZeppelin StandardMerkleTree dump: the proof for the value at treeIndex i (a heap: siblings up to the root). */
function ozProof(tree, i) {
  const proof = [];
  while (i > 0) {
    proof.push(tree[i % 2 === 1 ? i + 1 : i - 1]);
    i = Math.floor((i - 1) / 2);
  }
  return proof;
}

module.exports = { leaf, hashPair, rootOf, verify, ozProof, sameHash };

/**
 * Find money without a chain: Merkle proofs in each format, reading
 * published trees, the claim fee in the catalog, and what requests must say.
 * (The whole flow, with real claims and fees, is test/claims.e2e.js.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const merkle = require('../src/lib/merkle');
const claims = require('../src/services/claims');
const catalog = require('../src/payments/catalog');

const coder = ethers.AbiCoder.defaultAbiCoder();
const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20), C = '0x' + '33'.repeat(20), T = '0x' + '44'.repeat(20);

/** An OpenZeppelin StandardMerkleTree dump, built the way the library builds it. */
function ozDump(values) {
  const leaves = values.map((v, i) => ({ i, h: ethers.keccak256(ethers.keccak256(coder.encode(['address', 'uint256'], v))) })).sort((x, y) => (BigInt(x.h) < BigInt(y.h) ? -1 : 1));
  const size = 2 * leaves.length - 1;
  const tree = new Array(size);
  leaves.forEach((l, k) => { tree[size - 1 - k] = l.h; });
  for (let i = size - 1 - leaves.length; i >= 0; i--) tree[i] = merkle.hashPair(tree[2 * i + 1], tree[2 * i + 2]);
  const at = Object.fromEntries(leaves.map((l, k) => [l.i, size - 1 - k]));
  return { format: 'standard-v1', leafEncoding: ['address', 'uint256'], tree, values: values.map((v, i) => ({ value: [v[0], String(v[1])], treeIndex: at[i] })) };
}

test('merkle: each format\'s leaf, and proofs that lead to the root (and only for the right amount)', () => {
  const entries = [{ account: A, token: T, amount: 5n }, { account: B, token: T, amount: 7n }];
  const leaves = entries.map(e => merkle.leaf('merkl', e));
  const root = merkle.hashPair(leaves[0], leaves[1]);
  assert.ok(merkle.verify('merkl', entries[0], [leaves[1]], root));
  assert.ok(!merkle.verify('merkl', { ...entries[0], amount: 6n }, [leaves[1]], root), 'a different amount doesn\'t verify');
  assert.ok(!merkle.verify('uniswap', { ...entries[0], idx: 0 }, [leaves[1]], root), 'nor a different leaf encoding');
  assert.equal(merkle.leaf('uniswap', { idx: '3', account: A, amount: 9n }), ethers.solidityPackedKeccak256(['uint256', 'address', 'uint256'], [3, A, 9n]));
  assert.equal(merkle.verify('nope', entries[0], [], root), false, 'an unknown format never verifies');
});

test('published trees: Uniswap and OpenZeppelin formats are read into entries whose proofs verify', () => {
  const dump = ozDump([[A, 100n], [B, 200n], [C, 300n]]);
  const oz = claims.parseTree('oz-standard', dump);
  assert.equal(oz.root, dump.tree[0]);
  assert.equal(oz.entries.length, 3);
  for (const e of oz.entries) assert.ok(merkle.verify('oz-standard', e, e.proof, oz.root), `${e.account} verifies`);

  const uni = claims.parseTree('uniswap', { merkleRoot: '0x' + 'ab'.repeat(32), claims: { [ethers.getAddress(A)]: { index: 4, amount: '0x10', proof: [] } } });
  assert.deepEqual(uni.entries, [{ idx: '4', account: A, amount: '16', proof: [] }]);
  assert.throws(() => claims.parseTree('oz-standard', { ...dump, leafEncoding: ['address', 'address', 'uint256'] }), /Only \[address, uint256\]/);
  assert.throws(() => claims.parseTree('uniswap', {}), /merkleRoot and claims/);
});

test('claim fee: 5%, 3% with Safety Pro, paid by a transfer the user signs (never through the gate)', () => {
  const p = catalog.product('airdrop_claim');
  assert.deepEqual([p.kind, p.fee_bps, p.pro_fee_bps], ['fee', 500, 300]);
  assert.deepEqual(catalog.rails(p), ['claim_transfer']);
  assert.ok(catalog.SAFETY_PRO.covers.includes('airdrop_claim'));
  assert.match(catalog.product('pro_30d').description, /3% claim fee/);
  const listed = catalog.publicCatalog().find(x => x.id === 'airdrop_claim');
  assert.deepEqual([listed.fee_bps, listed.pro_fee_bps], [500, 300]);
});

test('requests: a wallet, the chain and the items; an airdrop needs https, a source and parseable functions', () => {
  assert.match(claims.parseWallet({ wallet: 'x' }).error, /wallet/);
  assert.deepEqual(claims.parseWallet({ wallet: A.toUpperCase().replace('0X', '0x') }), { wallet: A });
  assert.match(claims.parsePrepare({ wallet: A, chain: 'base' }).error, /ids/);
  assert.match(claims.parsePrepare({ wallet: A, chain: 'mars', ids: ['x'] }).error, /chain/);
  assert.deepEqual(claims.parsePrepare({ wallet: A, chain: 'base', ids: ['x', 'x'] }), { wallet: A, chain: 'base', ids: ['x'] });

  const ok = { slug: 'a-drop', name: 'A', chain: 'base', distributor: B, token: T, format: 'uniswap', tree_url: 'https://x.org/t.json', official_url: 'https://x.org', source: 'announcement' };
  const parsed = claims.parseProgram(ok);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.claimed_signature, 'isClaimed(uint256 index)', 'Uniswap defaults');
  assert.match(claims.parseProgram({ ...ok, tree_url: 'http://x.org/t.json' }).error, /https/);
  assert.match(claims.parseProgram({ ...ok, source: '' }).error, /source/);
  assert.match(claims.parseProgram({ ...ok, format: 'oz-standard' }).error, /claim_signature/);
  assert.match(claims.parseProgram({ ...ok, claim_signature: 'claim(uint256 index' }).error, /doesn't parse/);
  assert.match(claims.parseProgram({ ...ok, slug: 'Bad Slug' }).error, /slug/);
});

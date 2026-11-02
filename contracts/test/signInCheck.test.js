/**
 * SignInCheck6492: sign-in for a Coinbase Smart Wallet that isn't deployed yet.
 *
 * Runs on a copy of Base Sepolia against Coinbase's real wallet factory, with
 * the check's creation code in a deployless eth_call, exactly as the service
 * runs it (src/auth/erc6492.js).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, before } from 'node:test';
import { network } from 'hardhat';

const { ethers } = await network.create();
const coder = ethers.AbiCoder.defaultAbiCoder();

const CB_FACTORY = '0xba5ed110efdba3d005bfc882d75358acbbb85842';
const CB_FACTORY_ABI = ['function createAccount(bytes[] owners, uint256 nonce) payable returns (address)', 'function getAddress(bytes[] owners, uint256 nonce) view returns (address)'];

const artifact = JSON.parse(readFileSync(new URL('../artifacts/contracts/SignInCheck6492.sol/SignInCheck6492.json', import.meta.url)));
const exported = JSON.parse(readFileSync(new URL('../../src/auth/signInCheck6492.json', import.meta.url)));

/** A Coinbase Smart Wallet owner's EIP-1271 signature: over the wallet's replay-safe hash, wrapped with the owner's index. */
async function cbSign(ownerKey, wallet, hash, ownerIndex = 0) {
  const { chainId } = await ethers.provider.getNetwork();
  const digest = ethers.TypedDataEncoder.hash(
    { name: 'Coinbase Smart Wallet', version: '1', chainId, verifyingContract: wallet },
    { CoinbaseSmartWalletMessage: [{ name: 'hash', type: 'bytes32' }] },
    { hash },
  );
  const sig = ownerKey.signingKey.sign(digest).serialized;
  return coder.encode(['tuple(uint256,bytes)'], [[ownerIndex, sig]]);
}
const check = (signer, hash, factory, calldata, sig) => ethers.provider.call({
  data: exported.bytecode + coder.encode(['address', 'bytes32', 'address', 'bytes', 'bytes'], [signer, hash, factory, calldata, sig]).slice(2),
});

describe('SignInCheck6492: sign-in for a smart wallet that is not deployed yet', function () {
  let factory, owner, owners, nonce, wallet, createCall;
  const hash = ethers.hashMessage('localhost:8080 wants you to sign in with your Ethereum account');

  before(async function () {
    await ethers.provider.send('evm_mine', []); // calls need a local block on top of the fork
    factory = new ethers.Contract(CB_FACTORY, CB_FACTORY_ABI, ethers.provider);
    assert.ok((await ethers.provider.getCode(CB_FACTORY)).length > 2, 'Coinbase wallet factory not found');
    owner = ethers.Wallet.createRandom();
    owners = [coder.encode(['address'], [owner.address])];
    nonce = BigInt(Date.now());
    wallet = await factory.getFunction('getAddress')(owners, nonce);
    createCall = factory.interface.encodeFunctionData('createAccount', [owners, nonce]);
    assert.equal(await ethers.provider.getCode(wallet), '0x', 'the wallet must not exist yet');
  });

  it('the service carries the same code as the compiled contract', function () {
    assert.equal(exported.bytecode, artifact.bytecode, 'run `npm run export:signin-check` in contracts/');
  });

  it("the owner's signature passes before the wallet exists, and nothing is deployed", async function () {
    assert.equal(await check(wallet, hash, CB_FACTORY, createCall, await cbSign(owner, wallet, hash)), '0x01');
    assert.equal(await ethers.provider.getCode(wallet), '0x', 'an eth_call must leave no wallet behind');
  });

  it("someone else's signature fails", async function () {
    assert.equal(await check(wallet, hash, CB_FACTORY, createCall, await cbSign(ethers.Wallet.createRandom(), wallet, hash)), '0x00');
  });

  it('a signature for a different message fails', async function () {
    assert.equal(await check(wallet, ethers.hashMessage('something else'), CB_FACTORY, createCall, await cbSign(owner, wallet, hash)), '0x00');
  });

  it("a factory call that creates a different wallet (the attacker's own) proves nothing for this one", async function () {
    const attacker = ethers.Wallet.createRandom();
    const otherCall = factory.interface.encodeFunctionData('createAccount', [[coder.encode(['address'], [attacker.address])], nonce]);
    assert.equal(await check(wallet, hash, CB_FACTORY, otherCall, await cbSign(attacker, wallet, hash)), '0x00');
  });

  it('no factory, or a plain account with no code, fails', async function () {
    assert.equal(await check(wallet, hash, ethers.ZeroAddress, '0x', await cbSign(owner, wallet, hash)), '0x00');
    const eoa = ethers.Wallet.createRandom();
    assert.equal(await check(eoa.address, hash, CB_FACTORY, createCall, await eoa.signMessage('x')), '0x00');
  });

  it('once the wallet is deployed, the same check still answers (no factory call needed)', async function () {
    const [deployer] = await ethers.getSigners();
    await (await factory.connect(deployer).createAccount(owners, nonce)).wait();
    assert.ok((await ethers.provider.getCode(wallet)).length > 2);
    const sig = await cbSign(owner, wallet, hash);
    assert.equal(await check(wallet, hash, CB_FACTORY, createCall, sig), '0x01');
    const erc1271 = new ethers.Contract(wallet, ['function isValidSignature(bytes32,bytes) view returns (bytes4)'], ethers.provider);
    assert.equal(await erc1271.isValidSignature(hash, sig), '0x1626ba7e', 'our Coinbase signing matches the wallet');
  });
});

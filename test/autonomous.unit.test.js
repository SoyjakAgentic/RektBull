const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

test('the dev session key never signs in production or on a real network', async () => {
  const key = ethers.Wallet.createRandom();
  Object.assign(process.env, { DEV_SESSION_KEY: key.privateKey, SESSION_KEY_ADDRESS: key.address.toLowerCase(), KMS_SESSION_KEY_VERSION: '' });
  const env = require('../src/config/env');
  const { sessionSigner } = require('../src/trade/signers');

  assert.equal((await sessionSigner(84532, null)).address, key.address, 'Base Sepolia: allowed');
  await assert.rejects(sessionSigner(8453, null), /only sign on test networks, not chain 8453/, 'Base mainnet: refused');
  await assert.rejects(sessionSigner(1, null), /only sign on test networks/, 'Ethereum mainnet: refused');
  env.nodeEnv = 'production';
  await assert.rejects(sessionSigner(84532, null), /refused in production/);
  env.nodeEnv = 'test';
  env.sessionKeyAddress = ethers.Wallet.createRandom().address.toLowerCase();
  await assert.rejects(sessionSigner(84532, null), /but SESSION_KEY_ADDRESS says/, 'a key that isn\'t the one users granted is refused');
  env.devSessionKey = '';
  await assert.rejects(sessionSigner(84532, null), /no session key configured/);
});

test('exits: sell at the stop-loss or the take-profit, not in between', () => {
  const { exitReason } = require('../src/trade/exits');
  const at = valueUsd => exitReason({ valueUsd, costUsd: 100, stopLossPct: 20, takeProfitPct: 50 });
  assert.equal(at(100), null);
  assert.equal(at(81), null);
  assert.match(at(80), /^Stop-loss: down 20\.0%/);
  assert.match(at(10), /^Stop-loss: down 90\.0%/);
  assert.equal(at(149), null);
  assert.match(at(150), /^Take-profit: up 50\.0%/);
  assert.equal(exitReason({ valueUsd: 5, costUsd: 0, stopLossPct: 20, takeProfitPct: 50 }), null, 'no cost, no decision');
});

test('refusals come back in plain words, from the router\'s and MetaMask\'s errors', () => {
  const { revertReason, ROUTER } = require('../src/trade/autonomous');
  const data = ROUTER.encodeErrorResult('OverPeriodLimit', [10_250n * 10n ** 8n, 10_000n * 10n ** 8n]);
  assert.equal(revertReason({ data }), 'over your daily limit ($10,250 > $10,000)');
  assert.equal(revertReason({ info: { error: { data: ROUTER.encodeErrorResult('LimitsOff', []) } } }), 'your trading limits are off or expired on the router');
  const str = '0x08c379a0' + ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['AllowedTargetsEnforcer:target-address-not-allowed']).slice(2);
  assert.equal(revertReason({ data: str }), 'AllowedTargetsEnforcer:target-address-not-allowed');
  assert.equal(revertReason({ message: "reverted with custom error 'StalePrice(\"0xabc\")'" }), 'the reference price is out of date, so the router refuses to trade');
});

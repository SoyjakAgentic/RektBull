/**
 * Deploys the RektBull Trade Router and Safe Module to Base mainnet, signed on
 * a hardware wallet. No private key is ever read: the signer is Frame
 * (frame.sh), which holds no keys itself and asks the Ledger, Trezor or
 * other hardware wallet connected to it to sign.
 *
 *   1. Rehearse on a local copy of Base mainnet (nothing is sent):
 *        npm run deploy:base:rehearse
 *   2. Pre-flight against the real chain; prints and saves the plan:
 *        FEE_WALLET=0x<the fees Safe> npm run deploy:base
 *   3. Send. The hardware wallet shows two contract creations to approve:
 *        FEE_WALLET=0x<the fees Safe> DEPLOY=yes npm run deploy:base
 *   4. Check it any time after: npm run verify:base
 *
 * Every parameter comes from config/base.json and is read back from the chain
 * first (scripts/lib/baseDeploy.js). Nothing is sent unless every check
 * passes, the audited sources are unchanged, and DEPLOY=yes is set.
 * Writes deployments/base-plan.json, then deployments/base.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { network, artifacts } from 'hardhat';
import { ROOT, loadParams, routerArgs, checkSources, preflight, verifyDeployment, autoTradingEntry, print } from './lib/baseDeploy.js';

const conn = await network.create();
const { ethers } = conn;
const live = conn.networkName === 'base';
const rehearsal = conn.networkName === 'baseMainnetFork';

function write(name, data) {
  const file = path.join(ROOT, 'deployments', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return `deployments/${name}`;
}

async function main() {
  if (!live && !rehearsal) throw new Error(`run with --network base (Frame) or --network baseMainnetFork (a rehearsal), not ${conn.networkName}`);
  if (live && (process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY)) {
    throw new Error('unset DEPLOYER_PRIVATE_KEY: the mainnet deployment is signed on a hardware wallet through Frame, never with a key in the environment');
  }
  // A fork can't run calls at the block it was copied from; one new block fixes that.
  if (rehearsal) await ethers.provider.send('evm_mine', []);
  const p = loadParams();
  const routerArtifact = await artifacts.readArtifact('RektBullTradeRouter');
  const moduleArtifact = await artifacts.readArtifact('RektBullSafeModule');
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error('no account: open Frame, connect the hardware wallet, select its account and allow this connection');

  const feeWallet = process.env.FEE_WALLET || (rehearsal ? ethers.Wallet.createRandom().address : '');
  const sources = checkSources(p, routerArtifact);
  const pre = await preflight(ethers, p, { feeWallet, rehearsal });
  const sourcesOk = print('Audited sources', sources);
  const preOk = print(`Pre-flight on ${live ? 'Base mainnet' : 'a local copy of Base mainnet (rehearsal)'}`, pre);

  // ── The plan: exactly what will be sent ──
  const Router = await ethers.getContractFactory('RektBullTradeRouter', deployer);
  const args = routerArgs(p, feeWallet || ethers.ZeroAddress);
  const routerTx = await Router.getDeployTransaction(...args);
  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const predictedRouter = ethers.getCreateAddress({ from: deployer.address, nonce });
  const predictedModule = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
  const Module = await ethers.getContractFactory('RektBullSafeModule', deployer);
  const moduleTx = await Module.getDeployTransaction(predictedRouter);
  const fees = await ethers.provider.getFeeData();
  const gasPrice = fees.maxFeePerGas ?? fees.gasPrice;
  let gas = null;
  try { gas = (await ethers.provider.estimateGas({ ...routerTx, from: deployer.address })) + 1_500_000n; } catch (e) { pre.push({ name: 'gas estimate', ok: false, detail: e.shortMessage || e.message }); }
  const balance = await ethers.provider.getBalance(deployer.address);
  const need = gas ? (gas * gasPrice * 3n) / 2n : null; // half again for a moving gas price
  const fundsOk = need !== null && balance >= need;
  print('Deployer', [{ name: 'deployer', ok: fundsOk, detail: `${deployer.address}: ${ethers.formatEther(balance)} ETH, about ${need === null ? '?' : ethers.formatEther(need)} ETH needed for both contracts (RPC)` }]);

  const plan = {
    chainId: p.chainId, network: conn.networkName, preparedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim(),
    deployer: deployer.address, nonce, feeWallet,
    router: {
      predictedAddress: predictedRouter, constructorArgs: args.map(a => (Array.isArray(a) ? a.map(String) : String(a))),
      constructorArgsEncoded: Router.interface.encodeDeploy(args), initCodeHash: ethers.keccak256(routerTx.data),
    },
    safeModule: { predictedAddress: predictedModule, constructorArgsEncoded: Module.interface.encodeDeploy([predictedRouter]), initCodeHash: ethers.keccak256(moduleTx.data) },
    checks: [...sources, ...pre],
  };
  console.log(`\nPlan (${write(rehearsal ? 'base-fork-plan.json' : 'base-plan.json', plan)}):`);
  console.log(`  1. create RektBullTradeRouter at ${predictedRouter} (nonce ${nonce}), init code hash ${plan.router.initCodeHash}`);
  console.log(`  2. create RektBullSafeModule at ${predictedModule} (nonce ${nonce + 1}), pointing at the router`);
  console.log(`  fee ${p.feeBps / 100}% to ${feeWallet}; tokens ${p.tokens.map(t => t.symbol).join(', ')}`);

  if (!(preOk && fundsOk && (sourcesOk || rehearsal))) {
    console.log('\nNot deploying: fix every FAIL above first.');
    process.exitCode = 1;
    return;
  }
  if (live && process.env.DEPLOY !== 'yes') {
    console.log('\nPre-flight passed and nothing was sent. Read the plan, then run again with DEPLOY=yes.');
    console.log('On the hardware wallet, check each screen shows a contract creation from', deployer.address);
    return;
  }

  // ── Send ──
  const confirmations = live ? 3 : 1;
  console.log(`\nSending. ${live ? 'Approve each contract creation on the hardware wallet.' : ''}`);
  const router = await Router.deploy(...args, { nonce });
  const routerReceipt = await router.deploymentTransaction().wait(confirmations);
  console.log(`  router      ${router.target}  tx ${routerReceipt.hash}`);
  const safeModule = await Module.deploy(router.target, { nonce: nonce + 1 });
  const moduleReceipt = await safeModule.deploymentTransaction().wait(confirmations);
  console.log(`  safe module ${safeModule.target}  tx ${moduleReceipt.hash}`);

  const dep = {
    chainId: p.chainId, deployedAt: new Date().toISOString(), commit: plan.commit, deployer: deployer.address, feeWallet,
    router: router.target, routerTx: routerReceipt.hash, routerBlock: routerReceipt.blockNumber,
    safeModule: safeModule.target, safeModuleTx: moduleReceipt.hash,
    constructorArgsEncoded: plan.router.constructorArgsEncoded, params: 'config/base.json',
  };
  const out = write(rehearsal ? 'base-fork.json' : 'base.json', dep);
  const ok = print('Verification (read back from the chain)', await verifyDeployment(ethers, p, dep, { router: routerArtifact, module: moduleArtifact }));
  console.log(`\nwritten to ${out}`);
  if (!ok) { console.log('Verification FAILED: do not switch automatic trading on. Investigate first.'); process.exitCode = 1; return; }
  console.log(`\nAUTO_TRADING_NETWORKS entry:\n${JSON.stringify(autoTradingEntry(p, dep))}`);
  if (live) console.log('\nNext: npm run verify:base, verify both contracts on Basescan, then docs/BASE_DEPLOYMENT.md step 5 onwards.');
}

main().catch(err => { console.error(err.shortMessage || err.message || err); process.exit(1); });

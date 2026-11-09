/**
 * Checks the deployed Trade Router and Safe Module on Base mainnet against the
 * audited code and config/base.json, reading everything back from the chain:
 * code (apart from its settings), every setting, a live price through the
 * router, and who sent the deployment. Run it after deploying and whenever in
 * doubt; it needs no wallet.
 *
 *   npm run verify:base                    (reads deployments/base.json)
 *   DEPLOYMENT=deployments/x.json npx hardhat run scripts/verifyBase.js --network baseRead
 *
 * Also writes deployments/base-source.json: the compiler's standard JSON input,
 * compiler version and contract name, for "Verify and Publish" on Basescan
 * (Solidity, Standard-Json-Input), with the constructor arguments from
 * deployments/base.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { network, artifacts } from 'hardhat';
import { ROOT, loadParams, verifyDeployment, standardInput, autoTradingEntry, print } from './lib/baseDeploy.js';

const { ethers } = await network.create();

async function main() {
  const file = path.resolve(ROOT, process.env.DEPLOYMENT || 'deployments/base.json');
  if (!fs.existsSync(file)) throw new Error(`${path.relative(ROOT, file)} not found: deploy first (scripts/deployBase.js)`);
  const dep = JSON.parse(fs.readFileSync(file, 'utf8'));
  const p = loadParams();
  const router = await artifacts.readArtifact('RektBullTradeRouter');
  const module = await artifacts.readArtifact('RektBullSafeModule');
  const ok = print(`Trade Router ${dep.router}`, await verifyDeployment(ethers, p, dep, { router, module }));

  const src = standardInput(router);
  const out = path.join(ROOT, 'deployments', 'base-source.json');
  fs.writeFileSync(out, JSON.stringify({ ...src, routerConstructorArgs: dep.constructorArgsEncoded.replace(/^0x/, ''), safeModuleContract: src.contract.replace(/RektBullTradeRouter\.sol:RektBullTradeRouter$/, 'RektBullSafeModule.sol:RektBullSafeModule'), safeModuleConstructorArgs: ethers.AbiCoder.defaultAbiCoder().encode(['address'], [dep.router]).slice(2) }, null, 2) + '\n');
  console.log(`\nBasescan source input: deployments/base-source.json (compiler ${src.compiler}, contract ${src.contract})`);
  if (!ok) { console.log('\nVerification FAILED: do not switch automatic trading on.'); process.exitCode = 1; return; }
  console.log(`\nAUTO_TRADING_NETWORKS for the API and trade services (docs/BASE_DEPLOYMENT.md, step 6):\n${JSON.stringify(autoTradingEntry(p, dep))}`);
}

main().catch(err => { console.error(err.shortMessage || err.message || err); process.exit(1); });

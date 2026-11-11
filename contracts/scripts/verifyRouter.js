/**
 * Checks a deployed Trade Router and Safe Module (Base, Ethereum or Arbitrum)
 * against the audited code and config/<chain>.json, reading everything back
 * from the chain: code (apart from its settings), every setting, a live price
 * through the router, and who sent the deployment. Run it after deploying and
 * whenever in doubt; it needs no wallet.
 *
 *   npm run verify:<chain>             (reads deployments/<chain>.json)
 *   DEPLOYMENT=deployments/x.json npx hardhat run scripts/verifyRouter.js --network <chain>Read
 *
 * Also writes deployments/<chain>-source.json: the compiler's standard JSON
 * input, compiler version and contract name, for "Verify and Publish" on the
 * chain's explorer (Solidity, Standard-Json-Input), with the constructor
 * arguments from deployments/<chain>.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { network, artifacts } from 'hardhat';
import { ROOT, CHAINS, chainOfNetwork, loadParams, verifyDeployment, standardInput, autoTradingEntry, print } from './lib/routerDeploy.js';

const conn = await network.create();
const { ethers } = conn;
const chain = chainOfNetwork(conn.networkName);

async function main() {
  if (!chain) throw new Error(`run with --network <chain>Read, for a chain in ${CHAINS.join(', ')}; not ${conn.networkName}`);
  const file = path.resolve(ROOT, process.env.DEPLOYMENT || `deployments/${chain}.json`);
  if (!fs.existsSync(file)) throw new Error(`${path.relative(ROOT, file)} not found: deploy first (scripts/deployRouter.js)`);
  const dep = JSON.parse(fs.readFileSync(file, 'utf8'));
  const p = loadParams(chain);
  const router = await artifacts.readArtifact('RektBullTradeRouter');
  const module = await artifacts.readArtifact('RektBullSafeModule');
  const ok = print(`Trade Router ${dep.router}`, await verifyDeployment(ethers, p, dep, { router, module }));

  const src = standardInput(router);
  const out = path.join(ROOT, 'deployments', `${chain}-source.json`);
  fs.writeFileSync(out, JSON.stringify({ ...src, routerConstructorArgs: dep.constructorArgsEncoded.replace(/^0x/, ''), safeModuleContract: src.contract.replace(/RektBullTradeRouter\.sol:RektBullTradeRouter$/, 'RektBullSafeModule.sol:RektBullSafeModule'), safeModuleConstructorArgs: ethers.AbiCoder.defaultAbiCoder().encode(['address'], [dep.router]).slice(2) }, null, 2) + '\n');
  console.log(`\nExplorer source input (${p.explorer}): deployments/${chain}-source.json (compiler ${src.compiler}, contract ${src.contract})`);
  if (!ok) { console.log('\nVerification FAILED: do not switch automatic trading on.'); process.exitCode = 1; return; }
  console.log(`\nAUTO_TRADING_NETWORKS entry for the API and trade services (docs/ROUTER_DEPLOYMENT.md, step 6):\n${JSON.stringify(autoTradingEntry(p, dep))}`);
}

main().catch(err => { console.error(err.shortMessage || err.message || err); process.exit(1); });

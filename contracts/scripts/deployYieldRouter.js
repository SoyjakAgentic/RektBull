/**
 * Deploys the RektBull Yield Router on one chain, with RektBull's venue list
 * for that chain in the order the server expects (src/yield/venues.js,
 * routerVenues): a venue's id onchain is its index there.
 *
 *   YIELD_FEE_WALLET=0x... DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deployYieldRouter.js --network <net>
 *
 * Only after the audit (docs/YIELD_ROUTER.md). Run without --network to try
 * it on a local copy of the default network. The fee is 0.1% (the most the
 * contract allows), the minimum gain 1 point, one deposit or move a day.
 * Writes deployments/yield-router-<chainId>.json; set YIELD_ROUTERS on the
 * services from it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { network } from 'hardhat';

const require = createRequire(import.meta.url);
const venues = require('../../src/yield/venues.js');
const { ethers } = await network.create();

const FEE_BPS = 10;
const MIN_GAIN_BPS = 100;
const MIN_INTERVAL = 86400;

const chainId = Number((await ethers.provider.getNetwork()).chainId);
const chain = Object.entries(venues.CHAINS).find(([, c]) => c.chainId === chainId)?.[0];
if (!chain) throw new Error(`no RektBull venues on chain ${chainId} (${Object.keys(venues.CHAINS).join(', ')})`);
const feeWallet = process.env.YIELD_FEE_WALLET;
if (!ethers.isAddress(feeWallet || '')) throw new Error('set YIELD_FEE_WALLET (a receive-only Safe or hardware wallet)');
const list = venues.routerVenues(chain).map(v => ({ kind: v.kind, target: v.target, asset: v.assetAddress, position: v.position, rateSource: v.rateSource }));
console.log(`Yield Router on ${chain}: fee ${FEE_BPS / 100}% to ${feeWallet}, ${list.length} venues`);
venues.routerVenues(chain).forEach(v => console.log(`  ${v.id}: ${v.protocol} ${v.asset}`));
const router = await (await ethers.getContractFactory('RektBullYieldRouter')).deploy(feeWallet, FEE_BPS, MIN_GAIN_BPS, MIN_INTERVAL, list);
await router.waitForDeployment();
const out = { chain, chainId, router: await router.getAddress(), feeWallet, feeBps: FEE_BPS, minGainBps: MIN_GAIN_BPS, minInterval: MIN_INTERVAL, venues: venues.routerVenues(chain), deployedAt: new Date().toISOString() };
fs.mkdirSync(path.join(import.meta.dirname, '..', 'deployments'), { recursive: true });
fs.writeFileSync(path.join(import.meta.dirname, '..', 'deployments', `yield-router-${chainId}.json`), JSON.stringify(out, null, 2));
console.log(`deployed at ${out.router}`);

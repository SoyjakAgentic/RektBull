/**
 * Virtuals bonding-curve trades on a local copy of Base (fourMemeCheck.js does four.meme's on BNB Chain),
 * with the calls src/trade/calls.js builds. Nothing is sent to the real chain.
 *
 *   1. Virtuals' current curve, BondingV5 with FRouterV3: a buy (approval to FRouterV3, then
 *      BondingV5.buy) gets at least its minimum, a minimum the curve can't meet is refused by Virtuals'
 *      contract, and selling it all gives VIRTUAL back.
 *   2. Virtuals' old curve (Bonding with its FRouter), which RektBull only sells on: a holder sells with
 *      the calls RektBull builds, and RektBull refuses to build a buy there.
 *
 *   npx hardhat run scripts/curveCheck.js --network baseMainnetFork
 */
import { createRequire } from 'node:module';
import { network } from 'hardhat';

const require = createRequire(import.meta.url);
const lp = require('../../src/services/launchpads.js');
const { walletCalls } = require('../../src/trade/calls.js');
const { ethers } = await network.create();
await ethers.provider.send('evm_mine', []);

const BRIDGE = '0x4200000000000000000000000000000000000010'; // Base's L2 standard bridge: VIRTUAL's minter
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function mint(address to, uint256 amount)', 'function approve(address, uint256) returns (bool)'];
const ROUTER = ['function getAmountsOut(address, address, uint256) view returns (uint256)', 'function factory() view returns (address)', 'function hasAntiSniperTax(address) view returns (bool)'];
const FACTORY = ['function buyTax() view returns (uint256)', 'function sellTax() view returns (uint256)'];
const AH = '0x0000000000001ff3684f28c67538d4d072c22734';
const [deployer] = await ethers.getSigners();
const user = ethers.Wallet.createRandom().connect(ethers.provider);
await deployer.sendTransaction({ to: user.address, value: ethers.parseEther('1') });

// Give the user 200 VIRTUAL, as the bridge would.
await ethers.provider.send('hardhat_impersonateAccount', [BRIDGE]);
await deployer.sendTransaction({ to: BRIDGE, value: ethers.parseEther('1') });
await new ethers.Contract(lp.VIRTUAL, ERC20, await ethers.getSigner(BRIDGE)).mint(user.address, ethers.parseEther('200'));
const virtual = new ethers.Contract(lp.VIRTUAL, ERC20, user);
const deadline = async () => (await ethers.provider.getBlock('latest')).timestamp + 1200;
const send = async calls => { for (const c of calls) await (await user.sendTransaction({ to: c.to, data: c.data, value: c.value })).wait(); };
const zeroexLeg = { transaction: { to: AH, data: '0x', value: '0' }, sellAmount: 1n, allowanceSpender: null }; // the 0x leg is checked elsewhere

/** The newest token on a bonding contract that's open for trading (and, on BondingV5, past its anti-sniper tax). */
async function newestOpen(bondingAddr, iface, router) {
  const bonding = new ethers.Contract(bondingAddr, iface, ethers.provider);
  const exists = async i => !!(await bonding.tokenInfos(i).catch(() => null));
  let lo = 0, hi = 1;
  while (await exists(hi)) { lo = hi; hi *= 2; }
  while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (await exists(m)) lo = m; else hi = m; }
  for (let i = lo; i > lo - 200 && i >= 0; i--) {
    const t = (await bonding.tokenInfos(i)).toLowerCase();
    const inf = await bonding.tokenInfo(t);
    if (!inf.trading || (inf.launchExecuted === false)) continue;
    if (router && await router.hasAntiSniperTax(inf.pair)) continue;
    return { token: t, info: inf };
  }
  throw new Error(`no token open for trading on ${bondingAddr}`);
}

// ── 1. BondingV5 ──────────────────────────────────────────────────────────
{
  const frouter = new ethers.Contract(lp.ADDR.frouterV3, ROUTER, ethers.provider);
  const factory = new ethers.Contract(await frouter.factory(), FACTORY, ethers.provider);
  const [buyTax, sellTax] = [await factory.buyTax(), await factory.sellTax()];
  const { token, info } = await newestOpen(lp.ADDR.bondingV5, lp.BONDING_V5, frouter);
  console.log(`BondingV5: token ${token} (${info.data.ticker}), on the curve; taxes ${buyTax}% to buy, ${sellTax}% to sell, no anti-sniper tax running`);
  const virtualIn = ethers.parseEther('50');
  const expected = await frouter.getAmountsOut(token, lp.VIRTUAL, virtualIn - virtualIn * buyTax / 100n);
  const route = { kind: 'virtuals_curve', bonding: lp.ADDR.bondingV5, frouter: lp.ADDR.frouterV3, virtual: lp.VIRTUAL };
  const plan = { chain: 'base', side: 'buy', token, wallet: user.address, baseToken: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }, quote: zeroexLeg,
    route: { ...route, deadline: await deadline(), virtual_in: virtualIn.toString(), min_out: (expected * 99n / 100n).toString() } };
  await send(walletCalls(plan).calls.filter(c => c.step !== 'to_virtual'));
  const tokenC = new ethers.Contract(token, ERC20, user);
  const got = await tokenC.balanceOf(user.address);
  console.log(`  buy: 50 VIRTUAL gave ${ethers.formatEther(got)} tokens (quoted ${ethers.formatEther(expected)})`);
  if (got < expected * 99n / 100n) throw new Error('the buy gave less than its minimum');

  // A minimum above what the curve gives is refused by Virtuals' contract (nothing moves).
  const greedyPlan = { ...plan, route: { ...plan.route, virtual_in: ethers.parseEther('10').toString(), min_out: (expected * 10n).toString() } };
  const greedyCalls = walletCalls(greedyPlan).calls.filter(c => c.step !== 'to_virtual');
  await send([greedyCalls[0]]);
  let refused = false;
  try { await user.call({ to: greedyCalls[1].to, data: greedyCalls[1].data }); } catch { refused = true; }
  console.log(`  a minimum the curve can't meet: ${refused ? 'refused by Virtuals\' contract' : 'NOT REFUSED'}`);
  if (!refused) throw new Error('the minimum was not enforced');

  // Sell all of it, as calls.js builds it (the 0x leg after it is checked elsewhere).
  const quoteBack = await frouter.getAmountsOut(token, ethers.ZeroAddress, got);
  const minBack = (quoteBack - quoteBack * sellTax / 100n) * 99n / 100n;
  const before = await virtual.balanceOf(user.address);
  const sellPlan = { chain: 'base', side: 'sell', token, wallet: user.address, quote: zeroexLeg, route: { ...route, deadline: await deadline(), amount: got.toString(), min_virtual: minBack.toString() } };
  await send(walletCalls(sellPlan).calls.filter(c => c.step === 'approve' || c.step === 'swap').slice(0, 2));
  const back = (await virtual.balanceOf(user.address)) - before;
  console.log(`  sell: all of it gave ${ethers.formatEther(back)} VIRTUAL back (round trip ${(100 - Number(back * 10000n / virtualIn) / 100).toFixed(2)}% lost, the launchpad's taxes included); tokens left ${ethers.formatEther(await tokenC.balanceOf(user.address))}`);
  if (back < minBack) throw new Error('the sale gave less than its minimum');
}

// ── 2. The old Bonding: only sold on ─────────────────────────────────────
{
  const frouter = new ethers.Contract(lp.ADDR.frouter, ROUTER, ethers.provider);
  const { token, info } = await newestOpen(lp.ADDR.bonding, lp.BONDING, null);
  console.log(`old Bonding: token ${token} (${info.data.ticker}), still on its curve`);
  const route = { kind: 'virtuals_curve', bonding: lp.ADDR.bonding, frouter: lp.ADDR.frouter, virtual: lp.VIRTUAL };
  let refusedBuy = false;
  try { walletCalls({ chain: 'base', side: 'buy', token, wallet: user.address, baseToken: { address: lp.VIRTUAL }, quote: zeroexLeg, route: { ...route, deadline: await deadline(), virtual_in: '1', min_out: '1' } }); } catch (err) { refusedBuy = /only sells/.test(err.message); }
  console.log(`  RektBull builds a buy there: ${refusedBuy ? 'no (refused)' : 'YES'}`);
  if (!refusedBuy) throw new Error('a buy on the old curve was built');

  // A holder, made the way an earlier holder was: a buy straight on the old contract (not through RektBull).
  const bonding = new ethers.Contract(lp.ADDR.bonding, lp.BONDING, user);
  await (await virtual.approve(lp.ADDR.frouter, ethers.parseEther('20'))).wait();
  await (await bonding.buy(ethers.parseEther('20'), token, 0n, await deadline())).wait();
  const tokenC = new ethers.Contract(token, ERC20, user);
  const held = await tokenC.balanceOf(user.address);
  console.log(`  a holder with ${ethers.formatEther(held)} tokens`);

  // The sale RektBull builds for that holder.
  const quoteBack = await frouter.getAmountsOut(token, ethers.ZeroAddress, held);
  const minBack = (quoteBack - quoteBack / 100n) * 99n / 100n;
  const before = await virtual.balanceOf(user.address);
  const sellPlan = { chain: 'base', side: 'sell', token, wallet: user.address, quote: zeroexLeg, route: { ...route, deadline: await deadline(), amount: held.toString(), min_virtual: minBack.toString() } };
  await send(walletCalls(sellPlan).calls.filter(c => c.step === 'approve' || c.step === 'swap').slice(0, 2));
  const back = (await virtual.balanceOf(user.address)) - before;
  console.log(`  sell: it gave ${ethers.formatEther(back)} VIRTUAL back; tokens left ${ethers.formatEther(await tokenC.balanceOf(user.address))}`);
  if (back < minBack) throw new Error('the sale on the old curve gave less than its minimum');
}
console.log('ok');

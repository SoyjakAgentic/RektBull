/**
 * A Virtuals bonding-curve buy and sell, on a local copy of Base, with the
 * calls src/trade/calls.js builds (an approval to Virtuals' FRouter, then
 * Bonding.buy / Bonding.sell). Checks the tokens arrive, the minimum holds,
 * and a sale gives VIRTUAL back. Nothing is sent to the real chain.
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
const [deployer] = await ethers.getSigners();
const user = ethers.Wallet.createRandom().connect(ethers.provider);
await deployer.sendTransaction({ to: user.address, value: ethers.parseEther('1') });

// Give the user 100 VIRTUAL, as the bridge would.
await ethers.provider.send('hardhat_impersonateAccount', [BRIDGE]);
await deployer.sendTransaction({ to: BRIDGE, value: ethers.parseEther('1') });
await new ethers.Contract(lp.VIRTUAL, ERC20, await ethers.getSigner(BRIDGE)).mint(user.address, ethers.parseEther('100'));
const virtual = new ethers.Contract(lp.VIRTUAL, ERC20, user);

// The newest token still on the curve, read the way the server reads it.
const bonding = new ethers.Contract(lp.ADDR.bonding, lp.BONDING, ethers.provider);
let token = null, info = null;
for (let i = 17400; i > 17000 && !token; i--) {
  const t = await bonding.tokenInfos(i).catch(() => null);
  if (!t) continue;
  const inf = await bonding.tokenInfo(t);
  if (inf.trading) { token = t.toLowerCase(); info = inf; }
}
console.log(`token ${token} (${info.data.ticker}), on the curve`);
const frouter = new ethers.Contract(lp.ADDR.frouter, ['function getAmountsOut(address, address, uint256) view returns (uint256)'], ethers.provider);
const quoteOut = async v => { const net = v - v / 100n; return frouter.getAmountsOut(token, lp.VIRTUAL, net); };

// The buy, as calls.js builds it (the 0x leg before it is checked elsewhere; here the user holds VIRTUAL already).
const virtualIn = ethers.parseEther('50');
const expected = await quoteOut(virtualIn);
const deadline = (await ethers.provider.getBlock('latest')).timestamp + 1200;
const plan = {
  chain: 'base', side: 'buy', token, wallet: user.address, baseToken: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  quote: { transaction: { to: '0x0000000000001ff3684f28c67538d4d072c22734', data: '0x', value: '0' }, sellAmount: 1n, allowanceSpender: null },
  route: { kind: 'virtuals_curve', bonding: lp.ADDR.bonding, frouter: lp.ADDR.frouter, virtual: lp.VIRTUAL, deadline, virtual_in: virtualIn.toString(), min_out: (expected * 99n / 100n).toString() },
};
const buyCalls = walletCalls(plan).calls.filter(c => c.step !== 'to_virtual');
for (const c of buyCalls) await (await user.sendTransaction({ to: c.to, data: c.data, value: c.value })).wait();
const tokenC = new ethers.Contract(token, ERC20, user);
const got = await tokenC.balanceOf(user.address);
console.log(`buy: 50 VIRTUAL gave ${ethers.formatEther(got)} tokens (quoted ${ethers.formatEther(expected)}); VIRTUAL left ${ethers.formatEther(await virtual.balanceOf(user.address))}`);
if (got < expected * 99n / 100n) throw new Error('the buy gave less than its minimum');

// A minimum above what the curve gives is refused by Virtuals' contract (nothing moves).
const tooMuch = { ...plan, route: { ...plan.route, virtual_in: ethers.parseEther('10').toString(), min_out: (expected * 10n).toString() } };
const [, greedy] = walletCalls(tooMuch).calls.filter(c => c.step !== 'to_virtual');
await (await user.sendTransaction({ to: lp.VIRTUAL, data: walletCalls(tooMuch).calls.find(c => c.step === 'approve').data })).wait();
let refused = false;
try { await user.call({ to: greedy.to, data: greedy.data }); } catch { refused = true; }
console.log(`a minimum the curve can't meet: ${refused ? 'refused by Virtuals\' contract' : 'NOT REFUSED'}`);
if (!refused) throw new Error('the minimum was not enforced');

// The sell of everything bought, as calls.js builds it (the 0x leg after it is checked elsewhere).
const sellPlan = {
  chain: 'base', side: 'sell', token, wallet: user.address,
  quote: { transaction: { to: '0x0000000000001ff3684f28c67538d4d072c22734', data: '0x', value: '0' }, sellAmount: 1n, allowanceSpender: null },
  route: { kind: 'virtuals_curve', bonding: lp.ADDR.bonding, frouter: lp.ADDR.frouter, virtual: lp.VIRTUAL, deadline, amount: got.toString(), min_virtual: ethers.parseEther('45').toString() },
};
const before = await virtual.balanceOf(user.address);
const sellCalls = walletCalls(sellPlan).calls.filter(c => c.step === 'approve' || c.step === 'swap').slice(0, 2);
for (const c of sellCalls) await (await user.sendTransaction({ to: c.to, data: c.data, value: c.value })).wait();
const back = (await virtual.balanceOf(user.address)) - before;
console.log(`sell: all of it gave ${ethers.formatEther(back)} VIRTUAL back (round trip ${(100 - Number(back * 10000n / virtualIn) / 100).toFixed(2)}% lost, the launchpad's 1% + 1% taxes included); tokens left ${ethers.formatEther(await tokenC.balanceOf(user.address))}`);
if (back < ethers.parseEther('45')) throw new Error('the sale gave less than its minimum');
console.log('ok');

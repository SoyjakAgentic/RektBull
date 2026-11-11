/**
 * A four.meme bonding-curve buy and sell, on a local copy of BNB Chain, with the calls
 * src/trade/calls.js builds (buyTokenAMAP on four.meme's TokenManager2 with BNB; an approval to it,
 * then sellToken paying RektBull's 1% from the sale). Checks the tokens arrive, the minimum holds,
 * the fee goes only to the fee wallet, and what the wallet is sure to get after it. Nothing is sent
 * to the real chain.
 *
 *   npx hardhat run scripts/fourMemeCheck.js --network bscMainnetFork
 */
import { createRequire } from 'node:module';
import { network } from 'hardhat';

const { ethers } = await network.create('bscMainnetFork');
await ethers.provider.send('evm_mine', []);
const feeWallet = ethers.Wallet.createRandom().address.toLowerCase();
process.env.SWAP_FEE_WALLET_EVM = feeWallet; // read by calls.js when it checks a sale's fee
const require = createRequire(import.meta.url);
const lp = require('../../src/services/launchpads.js');
const { walletCalls } = require('../../src/trade/calls.js');

const helper = new ethers.Contract(lp.FOURMEME.helper, lp.HELPER, ethers.provider);
const manager = new ethers.Contract(lp.FOURMEME.tokenManager, lp.TOKEN_MANAGER, ethers.provider);
const [deployer] = await ethers.getSigners();
const user = ethers.Wallet.createRandom().connect(ethers.provider);
await deployer.sendTransaction({ to: user.address, value: ethers.parseEther('2') });
const bnb = a => ethers.provider.getBalance(a);
const paid = r => r.gasUsed * r.gasPrice;

// The newest token on the curve, priced in BNB, with some buying already, read the way the server reads it.
const count = Number(await manager._tokenCount());
let token = null;
for (let i = count - 1; i > count - 200 && !token; i--) {
  const t = (await manager._tokens(i)).toLowerCase();
  const c = await helper.getTokenInfo(t);
  if (c.tokenManager.toLowerCase() === lp.FOURMEME.tokenManager && c.quote === ethers.ZeroAddress && !c.liquidityAdded && c.funds > ethers.parseEther('0.3')) token = t;
}
if (!token) throw new Error('no four.meme token on its curve with some buying among the newest 200');
const curve = await lp.fourMemeCurve(token).catch(() => null);
console.log(`token ${token}, on the curve${curve ? ` (${curve.curve.progress_pct}% sold)` : ''}`);
const erc = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)'], ethers.provider);
const AH = '0x0000000000001ff3684f28c67538d4d072c22734';
const zeroexLeg = { transaction: { to: AH, data: '0x', value: '0' }, sellAmount: 1n, allowanceSpender: null };

// The buy, as calls.js builds it (the 0x leg into BNB before it is checked elsewhere; here the user holds BNB already).
const funds = ethers.parseEther('0.1');
const est = await helper.tryBuy(token, 0, funds);
const minOut = est.estimatedAmount * 99n / 100n;
const buyPlan = {
  chain: 'bsc', side: 'buy', token, wallet: user.address, baseToken: { address: '0x55d398326f99059ff775485246999027b3197955' },
  quote: { ...zeroexLeg, minBuyAmount: funds },
  route: { kind: 'fourmeme_curve', token_manager: lp.FOURMEME.tokenManager, funds: funds.toString(), min_out: minOut.toString() },
};
const buy = walletCalls(buyPlan).calls.find(c => c.step === 'swap');
const before = await bnb(user.address);
const rb = await (await user.sendTransaction({ to: buy.to, data: buy.data, value: buy.value })).wait();
const got = await erc.balanceOf(user.address);
console.log(`buy: 0.1 BNB gave ${ethers.formatEther(got)} tokens (quoted ${ethers.formatEther(est.estimatedAmount)}); BNB spent ${ethers.formatEther(before - await bnb(user.address) - paid(rb))}`);
if (got < minOut) throw new Error('the buy gave less than its minimum');

// A minimum above what the curve gives is refused by four.meme's contract (nothing moves).
const greedy = walletCalls({ ...buyPlan, route: { ...buyPlan.route, min_out: (est.estimatedAmount * 2n).toString() } }).calls.find(c => c.step === 'swap');
let refused = false;
try { await user.call({ to: greedy.to, data: greedy.data, value: greedy.value }); } catch { refused = true; }
console.log(`a minimum the curve can't meet: ${refused ? 'refused by four.meme\'s contract' : 'NOT REFUSED'}`);
if (!refused) throw new Error('the minimum was not enforced');

// Sell half with RektBull's 1% (paid by four.meme's contract from the sale), as calls.js builds it.
const half = got / 2n - (got / 2n) % lp.FOURMEME_SELL_UNIT; // four.meme sells only whole multiples of 10^9 units ('GW' otherwise)
const s = await helper.trySell(token, half);
const minFunds = BigInt(s.funds) * 99n / 100n;
const fmBps = BigInt(curve?.curve.buy_tax_pct ?? 1) * 100n;
const gross = minFunds * 10000n / (10000n - fmBps) + 1n;
const sure = minFunds - (gross * 100n / 10000n + 1n); // as src/trade/rules.js works it out
const sellPlan = { chain: 'bsc', side: 'sell', token, wallet: user.address, quote: zeroexLeg, route: { kind: 'fourmeme_curve', token_manager: lp.FOURMEME.tokenManager, amount: half.toString(), min_funds: minFunds.toString(), fee_bps: 100, fee_recipient: feeWallet } };
const u0 = await bnb(user.address);
let gas = 0n;
for (const c of walletCalls(sellPlan).calls) gas += paid(await (await user.sendTransaction({ to: c.to, data: c.data, value: c.value })).wait());
const userGot = await bnb(user.address) - u0 + gas;
const feeGot = await bnb(feeWallet);
console.log(`sell half: the wallet got ${ethers.formatEther(userGot)} BNB (sure of at least ${ethers.formatEther(sure)}), the fee wallet ${ethers.formatEther(feeGot)} BNB (${(Number(feeGot * 1000000n / (BigInt(s.funds) + BigInt(s.fee))) / 10000).toFixed(2)}% of the sale before four.meme's fee)`);
if (userGot < sure) throw new Error('the wallet got less than it was sure to');
if (feeGot === 0n || feeGot > (BigInt(s.funds) + BigInt(s.fee)) / 100n + 1n) throw new Error('the fee wasn\'t 1%');

// An amount that isn't a whole multiple of 10^9 units is refused by four.meme ('GW'); calls.js never builds one.
let gw = '';
try { await user.call({ to: lp.FOURMEME.tokenManager, data: lp.TOKEN_MANAGER.encodeFunctionData('sellToken(uint256,address,uint256,uint256)', [0, token, (await erc.balanceOf(user.address)) - 1n, 0]) }); } catch (e) { gw = e.shortMessage || e.message; }
console.log(`an amount not a multiple of 10^9 units: ${/GW/.test(gw) ? 'refused by four.meme (GW)' : `NOT REFUSED (${gw})`}`);

// Sell the rest with no fee wallet set (the plain sellToken): all of the sale goes to the wallet.
const rest = (await erc.balanceOf(user.address)) / lp.FOURMEME_SELL_UNIT * lp.FOURMEME_SELL_UNIT;
const s2 = await helper.trySell(token, rest);
const plain = { ...sellPlan, route: { ...sellPlan.route, amount: rest.toString(), min_funds: (BigInt(s2.funds) * 99n / 100n).toString(), fee_bps: 0, fee_recipient: null } };
const u1 = await bnb(user.address);
gas = 0n;
for (const c of walletCalls(plain).calls) gas += paid(await (await user.sendTransaction({ to: c.to, data: c.data, value: c.value })).wait());
const got2 = await bnb(user.address) - u1 + gas;
console.log(`sell the rest, no fee: ${ethers.formatEther(got2)} BNB (quoted ${ethers.formatEther(s2.funds)}); tokens left ${ethers.formatEther(await erc.balanceOf(user.address))}; fee wallet unchanged: ${(await bnb(feeWallet)) === feeGot}`);
if (got2 < BigInt(s2.funds) * 99n / 100n || (await bnb(feeWallet)) !== feeGot) throw new Error('the plain sale went wrong');

// A buy paid in BNB: 99% to the curve, then 1% as a plain transfer to the fee wallet, as one batch would send them.
const total = ethers.parseEther('0.1'), fee = total / 100n, curveFunds = total - fee;
const est2 = await helper.tryBuy(token, 0, curveFunds);
const bnbPlan = { chain: 'bsc', side: 'buy', token, wallet: user.address, quote: {}, route: { kind: 'fourmeme_curve', token_manager: lp.FOURMEME.tokenManager, pay: 'bnb', funds: curveFunds.toString(), min_out: (est2.estimatedAmount * 99n / 100n).toString(), fee_bps: 100, fee_amount: fee.toString(), fee_recipient: feeWallet } };
const bnbCalls = walletCalls(bnbPlan).calls;
const f0 = await bnb(feeWallet), u2 = await bnb(user.address);
gas = 0n;
for (const c of bnbCalls) gas += paid(await (await user.sendTransaction({ to: c.to, data: c.data, value: c.value })).wait());
const got3 = await erc.balanceOf(user.address);
console.log(`buy paid in BNB (${bnbCalls.map(c => c.step).join(', ')}): ${ethers.formatEther(got3)} tokens (quoted ${ethers.formatEther(est2.estimatedAmount)}); the wallet spent ${ethers.formatEther(u2 - await bnb(user.address) - gas)} BNB, the fee wallet got ${ethers.formatEther(await bnb(feeWallet) - f0)} BNB`);
if (got3 < BigInt(bnbPlan.route.min_out) || (await bnb(feeWallet)) - f0 !== fee) throw new Error('the BNB-paid buy went wrong');
console.log('ok');

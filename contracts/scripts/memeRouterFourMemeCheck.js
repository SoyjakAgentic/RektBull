/**
 * The Meme Router against four.meme's real contracts, on a local copy of BNB Chain:
 * a user's signed limit buy (paid in WBNB, sent to four.meme as BNB) and a signed sale for BNB,
 * both filled by an executor key, with the fee and the user's limit price enforced by the router.
 * Nothing is sent to the real chain.
 *
 *   npx hardhat run scripts/memeRouterFourMemeCheck.js --network bscMainnetFork
 */
import { createRequire } from 'node:module';
import { network } from 'hardhat';

const require = createRequire(import.meta.url);
const lp = require('../../src/services/launchpads.js');
const { ethers } = await network.create('bscMainnetFork');
await ethers.provider.send('evm_mine', []);

const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const E18 = 10n ** 18n;
const [deployer, executor] = await ethers.getSigners();
const user = ethers.Wallet.createRandom().connect(ethers.provider);
const feeWallet = ethers.Wallet.createRandom().address;
await deployer.sendTransaction({ to: user.address, value: 2n * E18 });
const tm = lp.FOURMEME.tokenManager;
const router = await ethers.deployContract('RektBullMemeRouter', [feeWallet, 100, WBNB, [tm], [WBNB, USDT]]);
console.log(`router ${router.target}`);
const domain = { name: 'RektBull Meme Router', version: '1', chainId: 56, verifyingContract: router.target };
const types = { Order: [['account', 'address'], ['executor', 'address'], ['tokenIn', 'address'], ['tokenOut', 'address'], ['amountIn', 'uint256'], ['minAmountOut', 'uint256'], ['validAfter', 'uint64'], ['validUntil', 'uint64'], ['epoch', 'uint64'], ['salt', 'uint256']].map(([name, type]) => ({ name, type })) };
const until = (await ethers.provider.getBlock('latest')).timestamp + 3600;
const sign = async o => user.signTypedData(domain, types, o);

// The newest token on the curve with some buying, priced in BNB.
const helper = new ethers.Contract(lp.FOURMEME.helper, lp.HELPER, ethers.provider);
const manager = new ethers.Contract(tm, lp.TOKEN_MANAGER, ethers.provider);
// Found from live data (the newest four.meme tokens on the curve with some buying), then traded on the copy.
const live = await lp.newestOnFourMeme(10);
const token = live.sort((a, b) => b.curve.in_curve - a.curve.in_curve)[0]?.token;
if (!token) throw new Error('no four.meme token on its curve just now');
void manager;
console.log(`token ${token}`);
const erc = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], user);
const wbnb = new ethers.Contract(WBNB, ['function deposit() payable', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], user);

// 1. A limit buy: 0.1 WBNB, at least 99% of what four.meme quotes for the 0.099 BNB left after the fee.
await (await wbnb.deposit({ value: E18 })).wait();
await (await wbnb.approve(router.target, ethers.MaxUint256)).wait();
const amountIn = E18 / 10n, toTrade = amountIn - amountIn / 100n;
const q = await helper.tryBuy(token, 0, toTrade);
const buy = { account: user.address, executor: executor.address, tokenIn: WBNB, tokenOut: token, amountIn, minAmountOut: q.estimatedAmount * 99n / 100n, validAfter: 0, validUntil: until, epoch: 0, salt: 1 };
const buyFill = { amountIn, venue: tm, spender: tm, unwrapIn: true, venueCalldata: lp.TOKEN_MANAGER.encodeFunctionData('buyTokenAMAP', [token, toTrade, buy.minAmountOut]) };
const fw0 = await wbnb.balanceOf(feeWallet);
await (await router.connect(executor).fill(buy, await sign(buy), buyFill)).wait();
const got = await erc.balanceOf(user.address);
console.log(`limit buy filled by the executor: ${ethers.formatEther(got)} tokens to the user (quoted ${ethers.formatEther(q.estimatedAmount)}); fee wallet +${ethers.formatEther((await wbnb.balanceOf(feeWallet)) - fw0)} WBNB; router holds ${ethers.formatEther(await erc.balanceOf(router.target))} tokens, ${ethers.formatEther(await ethers.provider.getBalance(router.target))} BNB`);
if (got < buy.minAmountOut) throw new Error('below the user\'s limit');

// 2. A greedy limit (twice the quote) is refused: four.meme itself, then the router's own check.
const greedy = { ...buy, minAmountOut: q.estimatedAmount * 2n, salt: 2 };
let refused = '';
try { await router.connect(executor).fill.staticCall(greedy, await sign(greedy), { ...buyFill, venueCalldata: lp.TOKEN_MANAGER.encodeFunctionData('buyTokenAMAP', [token, toTrade, 0]) }); } catch (e) { refused = e.shortMessage || e.message; }
console.log(`a limit the curve can't meet: ${/BelowLimit/.test(refused) || /reverted/.test(refused) ? 'refused by the router' : `NOT REFUSED (${refused})`}`);
if (!refused) throw new Error('a greedy limit went through');

// 3. A stop-loss floor: sell everything for BNB, at least 90% of four.meme's quote less the 1% fee.
const amount = got - got % lp.FOURMEME_SELL_UNIT;
await (await erc.approve(router.target, amount)).wait();
const s = await helper.trySell(token, amount);
const sell = { account: user.address, executor: executor.address, tokenIn: token, tokenOut: NATIVE, amountIn: amount, minAmountOut: BigInt(s.funds) * 90n / 100n, validAfter: 0, validUntil: until, epoch: 0, salt: 3 };
const sellFill = { amountIn: amount, venue: tm, spender: tm, unwrapIn: false, venueCalldata: lp.TOKEN_MANAGER.encodeFunctionData('sellToken(uint256,address,uint256,uint256)', [0, token, amount, 0]) };
const u0 = await ethers.provider.getBalance(user.address), f0 = await ethers.provider.getBalance(feeWallet);
await (await router.connect(executor).fill(sell, await sign(sell), sellFill)).wait();
const userGot = (await ethers.provider.getBalance(user.address)) - u0, feeGot = (await ethers.provider.getBalance(feeWallet)) - f0;
console.log(`stop-loss sale filled by the executor: the user got ${ethers.formatEther(userGot)} BNB (four.meme quoted ${ethers.formatEther(s.funds)}), the fee wallet ${ethers.formatEther(feeGot)} BNB (${(Number(feeGot * 100000n / (userGot + feeGot)) / 1000).toFixed(2)}%); the user paid no gas; tokens left ${ethers.formatEther(await erc.balanceOf(user.address))}`);
if (userGot < sell.minAmountOut) throw new Error('below the user\'s floor');

console.log('ok');

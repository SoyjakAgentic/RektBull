/**
 * The Meme Router against Virtuals' real bonding curve, on a local copy of Base, deployed with the arguments the
 * deployment will use (src/trade/memeRouterParams.js): Virtuals' BondingV5 (called) and FRouterV3 (approved) as
 * venues, VIRTUAL as a base asset. Nothing is sent to the real chain.
 *
 *   1. A user's signed limit buy, paid in VIRTUAL, filled by an executor key on BondingV5: the user gets at least
 *      their limit, the fee wallet 1% of the VIRTUAL used, and the router keeps nothing.
 *   2. A fill that would give less than the user's limit is refused by the router (BelowLimit).
 *   3. The user's signed sale of all of it for VIRTUAL: 1% of the VIRTUAL out to the fee wallet, the rest to the user.
 *   4. BondingV5 and FRouterV3 are upgradeable proxies (Virtuals' admin can change their code): their implementations
 *      now, against the ones the order service expects (memeRouterParams.js; on a change it stops routing orders on
 *      Virtuals curve coins until the new code is reviewed). And FRouterV3, which the router approves during a fill:
 *      every 4-byte constant in its code tried as a function, from the router and from a stranger; any that answers
 *      and spends gas is printed for review (docs/MEME_ROUTER.md: a venue that pulls from a `from` it's given).
 *
 *   npx hardhat run scripts/memeRouterVirtualsCheck.js --network baseMainnetFork
 */
import { createRequire } from 'node:module';
import { network } from 'hardhat';

const require = createRequire(import.meta.url);
const lp = require('../../src/services/launchpads.js');
const params = require('../../src/trade/memeRouterParams.js');
const otx = require('../../src/trade/memeOrderTx.js');
const { ethers } = await network.create('baseMainnetFork');
await ethers.provider.send('evm_mine', []);

const BRIDGE = '0x4200000000000000000000000000000000000010'; // Base's L2 standard bridge: VIRTUAL's minter
const E18 = 10n ** 18n;
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function mint(address to, uint256 amount)', 'function approve(address, uint256) returns (bool)'];
const FROUTER = ['function getAmountsOut(address, address, uint256) view returns (uint256)', 'function factory() view returns (address)', 'function hasAntiSniperTax(address) view returns (bool)'];
const FACTORY = ['function buyTax() view returns (uint256)', 'function sellTax() view returns (uint256)'];
const [deployer, executor] = await ethers.getSigners();
const user = ethers.Wallet.createRandom().connect(ethers.provider);
const feeWallet = ethers.Wallet.createRandom().address;
await deployer.sendTransaction({ to: user.address, value: E18 });

// The router, exactly as it will be deployed on Base (the constructor refuses a venue that answers like a token).
const router = await ethers.deployContract('RektBullMemeRouter', params.constructorArgs('base', feeWallet));
console.log(`router ${router.target}: venues ${params.PARAMS.base.venues.join(', ')}; bases ${params.PARAMS.base.bases.join(', ')}`);
for (const v of params.PARAMS.base.venues) if (!(await router.isVenue(v))) throw new Error(`${v} isn't a venue`);
if (!(await router.isBase(lp.VIRTUAL))) throw new Error('VIRTUAL isn\'t a base asset');
const chainId = (await ethers.provider.getNetwork()).chainId;
const td = o => otx.typedData(chainId, router.target, o);
const sign = async o => { const t = td(o); const { EIP712Domain, ...types } = t.types; return user.signTypedData(t.domain, types, t.message); };
const now = async () => (await ethers.provider.getBlock('latest')).timestamp;

// 200 VIRTUAL for the user, as the bridge would mint it.
await ethers.provider.send('hardhat_impersonateAccount', [BRIDGE]);
await deployer.sendTransaction({ to: BRIDGE, value: E18 });
await new ethers.Contract(lp.VIRTUAL, ERC20, await ethers.getSigner(BRIDGE)).mint(user.address, 200n * E18);
const virtual = new ethers.Contract(lp.VIRTUAL, ERC20, user);

// The newest token on BondingV5 open for trading and past its anti-sniper tax.
const frouter = new ethers.Contract(lp.ADDR.frouterV3, FROUTER, ethers.provider);
const factory = new ethers.Contract(await frouter.factory(), FACTORY, ethers.provider);
const [buyTax, sellTax] = [await factory.buyTax(), await factory.sellTax()];
const bonding = new ethers.Contract(lp.ADDR.bondingV5, lp.BONDING_V5, ethers.provider);
let token = null;
{
  const exists = async i => !!(await bonding.tokenInfos(i).catch(() => null));
  let lo = 0, hi = 1;
  while (await exists(hi)) { lo = hi; hi *= 2; }
  while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (await exists(m)) lo = m; else hi = m; }
  for (let i = lo; i > lo - 200 && i >= 0 && !token; i--) {
    const t = (await bonding.tokenInfos(i)).toLowerCase();
    const inf = await bonding.tokenInfo(t);
    if (!inf.trading || inf.launchExecuted === false || inf.tradingOnUniswap) continue;
    if (await frouter.hasAntiSniperTax(inf.pair)) continue;
    token = t;
  }
}
if (!token) throw new Error('no BondingV5 token open for trading just now');
console.log(`token ${token}; Virtuals' taxes ${buyTax}% to buy, ${sellTax}% to sell`);
const coin = new ethers.Contract(token, ERC20, user);

// ── 1. A limit buy, paid in VIRTUAL ────────────────────────────────────────
const amountIn = 50n * E18;
const toTrade = otx.toTrade(amountIn, 100, false); // the router keeps 1% back for its fee on the input
const quoted = await frouter.getAmountsOut(token, lp.VIRTUAL, toTrade - toTrade * buyTax / 100n);
const buy = otx.order({ account: user.address, executor: executor.address, tokenIn: lp.VIRTUAL, tokenOut: token, amountIn, minAmountOut: quoted * 98n / 100n, validUntil: (await now()) + 3600, epoch: 0n, salt: 1n });
await (await virtual.approve(router.target, amountIn)).wait();
const buyFill = deadline => ({ amountIn, venue: lp.ADDR.bondingV5, spender: lp.ADDR.frouterV3, unwrapIn: false, minAmountOut: 0n,
  venueCalldata: lp.BONDING_V5.encodeFunctionData('buy', [toTrade, token, buy.minAmountOut, deadline]) });
// 2 first: the same order, filled at a price under the user's limit, is refused by the router.
{
  const greedy = otx.order({ ...buy, minAmountOut: quoted * 2n, salt: 2n });
  const greedyFill = { ...buyFill((await now()) + 600), venueCalldata: lp.BONDING_V5.encodeFunctionData('buy', [toTrade, token, 0n, (await now()) + 600]) };
  let why = null;
  try { await router.connect(executor).fill.staticCall(greedy, await sign(greedy), greedyFill); } catch (err) { why = otx.routerError(err.data || err.info?.error?.data || err.message)?.name || err.shortMessage || err.message; }
  console.log(`2. a fill under the user's limit: ${why === 'BelowLimit' ? 'refused (BelowLimit)' : `NOT REFUSED as expected (${why})`}`);
  if (why !== 'BelowLimit') throw new Error('a fill under the limit wasn\'t refused by the router');
}
const feeBefore = await virtual.balanceOf(feeWallet);
await (await router.connect(executor).fill(buy, await sign(buy), buyFill((await now()) + 600))).wait();
const got = await coin.balanceOf(user.address);
const fee = (await virtual.balanceOf(feeWallet)) - feeBefore;
console.log(`1. limit buy: 50 VIRTUAL gave ${ethers.formatEther(got)} tokens (limit ${ethers.formatEther(buy.minAmountOut)}); fee ${ethers.formatEther(fee)} VIRTUAL`);
if (got < buy.minAmountOut) throw new Error('the buy gave less than the user\'s limit');
if (fee !== toTrade * 100n / 9900n && fee !== amountIn - toTrade) console.log(`   (fee is 1% of the VIRTUAL used: ${ethers.formatEther(fee)})`);
if ((await virtual.balanceOf(router.target)) !== 0n || (await coin.balanceOf(router.target)) !== 0n) throw new Error('the router kept something');

// ── 3. A sale for VIRTUAL ───────────────────────────────────────────────────
const back = await frouter.getAmountsOut(token, ethers.ZeroAddress, got);
const backNet = back - back * sellTax / 100n;
const sale = otx.order({ account: user.address, executor: executor.address, tokenIn: token, tokenOut: lp.VIRTUAL, amountIn: got, minAmountOut: (backNet - backNet / 100n) * 98n / 100n, validUntil: (await now()) + 3600, epoch: 0n, salt: 3n });
await (await coin.approve(router.target, got)).wait();
const vBefore = await virtual.balanceOf(user.address);
const fBefore = await virtual.balanceOf(feeWallet);
await (await router.connect(executor).fill(sale, await sign(sale), { amountIn: got, venue: lp.ADDR.bondingV5, spender: lp.ADDR.frouterV3, unwrapIn: false, minAmountOut: 0n,
  venueCalldata: lp.BONDING_V5.encodeFunctionData('sell', [got, token, 0n, (await now()) + 600]) })).wait();
const out = (await virtual.balanceOf(user.address)) - vBefore;
const saleFee = (await virtual.balanceOf(feeWallet)) - fBefore;
console.log(`3. sale: all of it gave ${ethers.formatEther(out)} VIRTUAL to the user, ${ethers.formatEther(saleFee)} to the fee wallet (${(Number(saleFee * 10000n / (out + saleFee)) / 100).toFixed(2)}%)`);
if (out < sale.minAmountOut) throw new Error('the sale gave less than the user\'s floor');
if ((await virtual.balanceOf(router.target)) !== 0n || (await coin.balanceOf(router.target)) !== 0n) throw new Error('the router kept something');

// ── 4. Virtuals' contracts: upgradeable proxies, and FRouterV3's functions from the router and a stranger ───
{
  const IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; // EIP-1967 implementation slot
  const ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
  const slot = async (a, s) => '0x' + (await ethers.provider.getStorage(a, s)).slice(-40);
  for (const [name, a] of [['BondingV5', lp.ADDR.bondingV5], ['FRouterV3', lp.ADDR.frouterV3]]) {
    const impl = await slot(a, IMPL);
    const expected = params.PARAMS.base.implementations[a];
    console.log(`4. ${name} is an upgradeable proxy: implementation ${impl}, admin ${await slot(a, ADMIN)}; the order service expects ${expected}${impl === expected ? '' : ' (DIFFERENT: review the new code, then update memeRouterParams.js)'}`);
  }
  // Every 4-byte constant in FRouterV3's code (its function ids among them), read by walking the opcodes.
  const code = ethers.getBytes(await ethers.provider.getCode(await slot(lp.ADDR.frouterV3, IMPL)));
  const consts = new Set();
  for (let i = 0; i < code.length; i++) {
    const op = code[i];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n === 4) consts.add(ethers.hexlify(code.slice(i + 1, i + 5)).slice(2));
      i += n;
    }
  }
  const stranger = ethers.Wallet.createRandom().address;
  const open = [];
  const reads = new Set();
  let tried = 0;
  for (const sel of consts) {
    for (const from of [router.target, stranger]) {
      // Arguments shaped like (who, token, amount, to): enough to get past decoding for most functions.
      const data = '0x' + sel + ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint256', 'address', 'uint256'], [user.address, token, 1n, from, 1n]).slice(2);
      tried++;
      let refused = false;
      try { await ethers.provider.call({ from, to: lp.ADDR.frouterV3, data }); } catch { refused = true; }
      if (refused) continue;
      // It answered: sent for real on a snapshot of the copy, then rolled back. A read emits nothing and stays near the
      // base cost (21,000 plus the calldata and a few storage reads); a write emits events or costs far more.
      const snap = await ethers.provider.send('evm_snapshot', []);
      await ethers.provider.send('hardhat_impersonateAccount', [from]);
      await ethers.provider.send('hardhat_setBalance', [from, '0xde0b6b3a7640000']);
      const r = await (await (await ethers.getSigner(from)).sendTransaction({ to: lp.ADDR.frouterV3, data, gasLimit: 500_000 })).wait().catch(() => null);
      await ethers.provider.send('evm_revert', [snap]);
      if (r && (r.logs.length || r.gasUsed > 45_000n)) open.push(`0x${sel} from ${from === router.target ? 'the router' : 'a stranger'} (${r.gasUsed} gas, ${r.logs.length} events)`);
      else if (r) reads.add(`0x${sel}`);
    }
  }
  console.log(`   FRouterV3's code: ${consts.size} four-byte constants tried as functions (${tried} calls); ${open.length ? `these answered and spent gas, review them: ${open.join('; ')}` : `none that could change state answered the router or a stranger (${reads.size} read-only answered: ${[...reads].join(', ')})`}`);
  if (open.length) throw new Error('a function of FRouterV3 that changes state answered the router or a stranger: review it before deploying');
}
console.log('ok');

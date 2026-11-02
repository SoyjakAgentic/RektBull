/**
 * Live yield rates, read from each protocol's own contracts, the way their
 * own apps do (carried over from soyjak-agentic's yieldRates.js):
 *   - Aave v3: the reserve's currentLiquidityRate (per year, in ray,
 *     compounded per second); utilization is variable debt over the aToken
 *     supply; the configuration word says whether the reserve is active,
 *     frozen or paused, and its supply cap (aave-v3-origin
 *     ReserveConfiguration.sol: bits 56, 57, 60, 116-151).
 *   - Compound v3: getSupplyRate(getUtilization()), per second with 18
 *     decimals; isSupplyPaused / isWithdrawPaused.
 *   - Spark sUSDC: the Sky Savings Rate, ssr(), per second in ray, read from
 *     the Ethereum vault (the L2 vaults pay the same rate); maxDeposit.
 * DefiLlama's yields API is a cross-check, and the only source for reward
 * APYs (COMP, Aave incentives), which are shown but never counted by the
 * rules. It's never required: when it can't be reached, the onchain figures
 * stand alone. A rate that can't be read is null, with the reason, never a guess.
 *
 * Prices come from each chain's Aave oracle (USD, 8 decimals): onchain, no
 * API key, and what Aave itself liquidates by.
 */
const axios = require('axios');
const { ethers } = require('ethers');
const { cached } = require('../lib/cache');
const { track } = require('../providers/usage');
const { multicall } = require('../services/approvals');
const venues = require('./venues');

const SECONDS_PER_YEAR = 31536000;
const RAY = 10n ** 27n;
const RATE_TTL = 60;
const LLAMA_TTL = 15 * 60;
const LLAMA_CHAIN = { ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum' };

const I = {
  aave: new ethers.Interface([
    'function getReserveData(address asset) view returns (tuple(tuple(uint256 data) configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
    'function getReserveNormalizedIncome(address asset) view returns (uint256)',
  ]),
  erc20: new ethers.Interface(['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)']),
  comet: new ethers.Interface([
    'function getUtilization() view returns (uint256)', 'function getSupplyRate(uint256 utilization) view returns (uint64)',
    'function isSupplyPaused() view returns (bool)', 'function isWithdrawPaused() view returns (bool)', 'function totalSupply() view returns (uint256)',
  ]),
  spark: new ethers.Interface([
    'function ssr() view returns (uint256)', 'function maxDeposit(address) view returns (uint256)', 'function totalAssets() view returns (uint256)',
    'function convertToAssets(uint256 shares) view returns (uint256)',
  ]),
  oracle: new ethers.Interface(['function getAssetPrice(address asset) view returns (uint256)']),
};

const pct = x => Math.round(x * 10000) / 100;
const perSecondToApy = r => Math.pow(1 + r, SECONDS_PER_YEAR) - 1;
const ok = (r, k = 0) => (r.ok ? r.value[k] : null);
const units = (u, d) => (u === null || u === undefined ? null : ethers.formatUnits(u, d));

/** A reserve's flags and supply cap, from Aave's configuration word. */
function aaveFlags(word) {
  const w = BigInt(word);
  const bit = n => ((w >> BigInt(n)) & 1n) === 1n;
  return { active: bit(56), frozen: bit(57), paused: bit(60), supplyCap: (w >> 116n) & 0xFFFFFFFFFn };
}

async function aaveRate(v, asset) {
  const token = venues.tokenOf(v.chain, asset);
  const [rd] = await multicall(v.chain, [{ target: v.pool, iface: I.aave, fn: 'getReserveData', args: [token.address] }]);
  if (!rd.ok) throw new Error('Aave\'s reserve data couldn\'t be read');
  const r = rd.value[0];
  const flags = aaveFlags(r.configuration.data ?? r.configuration[0]);
  const [supplied, debt, cash, income] = (await multicall(v.chain, [
    { target: r.aTokenAddress, iface: I.erc20, fn: 'totalSupply', args: [] },
    { target: r.variableDebtTokenAddress, iface: I.erc20, fn: 'totalSupply', args: [] },
    { target: token.address, iface: I.erc20, fn: 'balanceOf', args: [r.aTokenAddress] },
    { target: v.pool, iface: I.aave, fn: 'getReserveNormalizedIncome', args: [token.address] },
  ])).map(x => (x.ok ? BigInt(x.value[0]) : null));
  const capUnits = flags.supplyCap * 10n ** BigInt(token.decimals);
  const capRoom = flags.supplyCap === 0n || supplied === null ? null : (capUnits > supplied ? capUnits - supplied : 0n);
  return {
    apy: perSecondToApy(Number(BigInt(r.currentLiquidityRate) * 10n ** 9n / RAY) / 1e9 / SECONDS_PER_YEAR),
    utilization: supplied > 0n && debt !== null ? Number(debt * 10000n / supplied) / 10000 : 0,
    supplied, liquidity: cash, capRoom, index: income,
    supplyOpen: flags.active && !flags.frozen && !flags.paused && capRoom !== 0n,
    withdrawOpen: flags.active && !flags.paused,
    flags: { frozen: flags.frozen, paused: flags.paused, active: flags.active, supply_cap_reached: capRoom === 0n },
    decimals: token.decimals,
  };
}

async function cometRate(v, asset) {
  const token = venues.tokenOf(v.chain, asset);
  const [u, sp, wp, cash, total] = await multicall(v.chain, [
    { target: v.comet, iface: I.comet, fn: 'getUtilization', args: [] },
    { target: v.comet, iface: I.comet, fn: 'isSupplyPaused', args: [] },
    { target: v.comet, iface: I.comet, fn: 'isWithdrawPaused', args: [] },
    { target: token.address, iface: I.erc20, fn: 'balanceOf', args: [v.comet] },
    { target: v.comet, iface: I.comet, fn: 'totalSupply', args: [] },
  ]);
  if (!u.ok) throw new Error('Compound\'s utilization couldn\'t be read');
  const utilization = BigInt(u.value[0]);
  const [rate] = await multicall(v.chain, [{ target: v.comet, iface: I.comet, fn: 'getSupplyRate', args: [utilization] }]);
  if (!rate.ok) throw new Error('Compound\'s supply rate couldn\'t be read');
  return {
    apy: perSecondToApy(Number(BigInt(rate.value[0])) / 1e18),
    utilization: Number(utilization * 10000n / 10n ** 18n) / 10000,
    supplied: ok(total) === null ? null : BigInt(ok(total)), liquidity: ok(cash) === null ? null : BigInt(ok(cash)), capRoom: null, index: null,
    supplyOpen: ok(sp) === false, withdrawOpen: ok(wp) === false,
    flags: { supply_paused: ok(sp) === true, withdraw_paused: ok(wp) === true },
    decimals: token.decimals,
  };
}

async function sparkRate(v) {
  const [[ssr], [maxDeposit, totalAssets, perShare]] = await Promise.all([
    multicall('ethereum', [{ target: venues.SPARK_SSR_SOURCE, iface: I.spark, fn: 'ssr', args: [] }]),
    multicall(v.chain, [
      { target: v.vault, iface: I.spark, fn: 'maxDeposit', args: [ethers.ZeroAddress] },
      { target: v.vault, iface: I.spark, fn: 'totalAssets', args: [] },
      { target: v.vault, iface: I.spark, fn: 'convertToAssets', args: [10n ** 18n] },
    ]),
  ]);
  if (!ssr.ok) throw new Error('the Sky Savings Rate couldn\'t be read');
  const room = ok(maxDeposit) === null ? null : BigInt(ok(maxDeposit));
  return {
    apy: Math.pow(Number(BigInt(ssr.value[0]) * 10n ** 12n / RAY) / 1e12, SECONDS_PER_YEAR) - 1,
    utilization: null,
    supplied: ok(totalAssets) === null ? null : BigInt(ok(totalAssets)), liquidity: null, capRoom: room,
    index: ok(perShare) === null ? null : BigInt(ok(perShare)),
    supplyOpen: room === null ? false : room > 0n,
    withdrawOpen: null, // known per holder, at withdrawal time (maxWithdraw)
    flags: {},
    decimals: 6,
  };
}

/** DefiLlama's rows for our venues only (the full list is megabytes), cached. */
async function llamaRows() {
  return cached('yield:llama:venues', LLAMA_TTL, async () => {
    const data = await track('defillama', async () => (await axios.get('https://yields.llama.fi/pools', { timeout: 20000 })).data);
    const pools = Array.isArray(data?.data) ? data.data : [];
    const out = {};
    for (const v of venues.VENUES) {
      for (const asset of v.assets) {
        const address = venues.tokenOf(v.chain, asset).address;
        const p = pools.find(x => x.chain === LLAMA_CHAIN[v.chain] && x.project === v.protocol && (x.underlyingTokens || []).some(t => String(t).toLowerCase() === address));
        const n = x => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
        if (p) out[`${v.protocol}|${v.chain}|${asset}`] = { apy_base_pct: n(p.apyBase), apy_reward_pct: n(p.apyReward), tvl_usd: n(p.tvlUsd) };
      }
    }
    return out;
  }).catch(() => null);
}

/**
 * One venue's rate for one asset. An unreadable rate comes back with
 * `error` and apy_pct null.
 */
async function venueRate(v, asset, { crossCheck = true } = {}) {
  const base = { protocol: v.protocol, chain: v.chain, chain_label: venues.CHAINS[v.chain].label, name: v.name, asset, status: v.status };
  const value = await cached(`yield:rate:${v.protocol}:${v.chain}:${asset}`, RATE_TTL, async () => {
    try {
      const r = v.kind === 'aave' ? await aaveRate(v, asset) : v.kind === 'comet' ? await cometRate(v, asset) : await sparkRate(v);
      return {
        ...base, apy_pct: pct(r.apy), source: `${v.name}'s contracts onchain`,
        utilization_pct: r.utilization === null ? null : pct(r.utilization),
        supplied: units(r.supplied, r.decimals), available_liquidity: units(r.liquidity, r.decimals), deposit_room: units(r.capRoom, r.decimals),
        index: r.index === null ? null : r.index.toString(),
        supply_open: v.status === 'open' && r.supplyOpen, withdraw_open: r.withdrawOpen, flags: r.flags,
        read_at: new Date().toISOString(),
      };
    } catch (err) {
      return { ...base, apy_pct: null, source: null, supply_open: false, error: err.message, read_at: new Date().toISOString() };
    }
  });
  if (!crossCheck) return value;
  const llama = await llamaRows();
  const row = llama?.[`${v.protocol}|${v.chain}|${asset}`];
  return { ...value, ...(row ? { defillama: { ...row, source: 'DefiLlama yields' } } : {}) };
}

/** Every venue's rate, optionally for one chain or asset. */
async function listRates({ chain = null, asset = null } = {}) {
  const want = String(asset || '').toUpperCase();
  const jobs = [];
  for (const v of venues.VENUES) {
    if (chain && v.chain !== chain) continue;
    for (const a of v.assets) if (!want || a === want) jobs.push(venueRate(v, a));
  }
  return Promise.all(jobs);
}

/** An asset's price in dollars from the chain's Aave oracle (cached a minute). */
async function priceUsd(chain, asset) {
  return cached(`yield:price:${chain}:${asset}`, 60, async () => {
    const token = venues.tokenOf(chain, asset);
    const [p] = await multicall(chain, [{ target: venues.CHAINS[chain].aaveOracle, iface: I.oracle, fn: 'getAssetPrice', args: [token.address] }]);
    if (!p.ok) throw new Error(`Aave's oracle on ${chain} couldn't price ${asset}`);
    return Number(BigInt(p.value[0])) / 1e8;
  });
}

module.exports = { SECONDS_PER_YEAR, I, aaveFlags, venueRate, listRates, priceUsd, llamaRows };

/**
 * Base launchpads, each recognised by its own contract onchain (addresses
 * confirmed against verified source on Sourcify and their code onchain,
 * 11 November 2026):
 *
 *   Clanker (v4)  factory 0xE85A59c628F7d27878ACeB4bf3b35733630083a9 (src/Clanker.sol:Clanker):
 *                 deploymentInfoForToken(token) names its hook and its LP locker.
 *                 Its tokens trade on Uniswap v4 from launch, through 0x.
 *   Zora coins    factory 0x777777751622c0d3258f214F9DF38E35BF45baF3 (ZoraFactory, a proxy to
 *                 ZoraFactoryImpl): getVersionForDeployedCoin(coin) is its coin version.
 *                 Coins trade on Uniswap v4 from launch, through 0x.
 *   Virtuals      Bonding 0xF66DeA7b3e897cD44A5a231c61B6B4423d613259 (a proxy to Bonding) and
 *                 FRouter 0x8292B43aB73EfAC11FAF357419C38ACF448202C5 (a proxy to FRouter), priced
 *                 in VIRTUAL 0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b. A token starts on
 *                 Virtuals' bonding curve (Bonding.buy / sell, approving FRouter, 1% buy and
 *                 sell tax read from its factory) and graduates to Uniswap as a new agent
 *                 token once the curve's token reserve falls to gradThreshold.
 *
 * identify() is what the Launches desk and the Trade desk read: which
 * launchpad, and for Virtuals whether the token is still on its curve.
 */
const { ethers } = require('ethers');
const rpc = require('../providers/rpc');
const { cached } = require('../lib/cache');

const VIRTUAL = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
const ADDR = {
  clanker: '0xe85a59c628f7d27878aceb4bf3b35733630083a9',
  zora: '0x777777751622c0d3258f214f9df38e35bf45baf3',
  bonding: '0xf66dea7b3e897cd44a5a231c61b6b4423d613259',
  frouter: '0x8292b43ab73efac11faf357419c38acf448202c5',
};
const SOURCE = {
  clanker: 'Clanker\'s factory onchain (deploymentInfoForToken)',
  zora: 'Zora\'s coin factory onchain (getVersionForDeployedCoin)',
  virtuals: 'Virtuals\' Bonding contract onchain (tokenInfo)',
};

const CLANKER = new ethers.Interface(['function deploymentInfoForToken(address) view returns (address token, address hook, address locker)']);
const ZORA = new ethers.Interface(['function getVersionForDeployedCoin(address) view returns (uint8)']);
const BONDING = new ethers.Interface([
  'function tokenInfo(address) view returns (address creator, address token, address pair, address agentToken, (address token, string name, string _name, string ticker, uint256 supply, uint256 price, uint256 marketCap, uint256 liquidity, uint256 volume, uint256 volume24H, uint256 prevPrice, uint256 lastUpdated) data, string description, string image, string twitter, string telegram, string youtube, string website, bool trading, bool tradingOnUniswap)',
  'function tokenInfos(uint256) view returns (address)',
  'function gradThreshold() view returns (uint256)',
  'function buy(uint256 amountIn, address tokenAddress, uint256 amountOutMin, uint256 deadline) payable returns (bool)',
  'function sell(uint256 amountIn, address tokenAddress, uint256 amountOutMin, uint256 deadline) returns (bool)',
]);
const FROUTER = new ethers.Interface(['function getAmountsOut(address token, address assetToken_, uint256 amountIn) view returns (uint256)', 'function factory() view returns (address)']);
const FFACTORY = new ethers.Interface(['function buyTax() view returns (uint256)', 'function sellTax() view returns (uint256)']);
const PAIR = new ethers.Interface(['function getReserves() view returns (uint256, uint256)']);

async function call(to, iface, fn, args = []) {
  const raw = await rpc.evmRpc('base', 'eth_call', [{ to, data: iface.encodeFunctionData(fn, args) }, 'latest']);
  return iface.decodeFunctionResult(fn, raw);
}
const tryCall = (...a) => call(...a).catch(() => null);
const ZERO = '0x0000000000000000000000000000000000000000';

const LINKS = {
  clanker: t => `https://clanker.world/clanker/${t}`,
  zora: t => `https://zora.co/coin/base:${t}`,
  virtuals: t => `https://app.virtuals.io/prototypes/${t}`,
};

/** Virtuals' curve, read now: whether it trades, its taxes, and how far it is towards graduating. */
async function virtualsCurve(token) {
  const info = await call(ADDR.bonding, BONDING, 'tokenInfo', [token]);
  if (String(info.token).toLowerCase() !== token) return null;
  const out = {
    launchpad: 'virtuals', name: 'Virtuals', ticker: info.data.ticker, creator: String(info.creator).toLowerCase(),
    state: info.trading ? 'curve' : info.tradingOnUniswap ? 'graduated' : 'closed',
    agent_token: info.agentToken && info.agentToken !== ZERO ? String(info.agentToken).toLowerCase() : null,
    link: LINKS.virtuals(token), source: SOURCE.virtuals,
  };
  if (out.state === 'curve') {
    const [[reserveToken, reserveVirtual], [threshold], [factory]] = await Promise.all([
      call(info.pair, PAIR, 'getReserves'), call(ADDR.bonding, BONDING, 'gradThreshold'), call(ADDR.frouter, FROUTER, 'factory'),
    ]);
    const [[buyTax], [sellTax]] = await Promise.all([call(factory, FFACTORY, 'buyTax'), call(factory, FFACTORY, 'sellTax')]);
    const supply = BigInt(info.data.supply);
    const sold = supply > reserveToken ? supply - reserveToken : 0n;
    const toSell = supply > threshold ? supply - threshold : 1n;
    out.curve = {
      pair: String(info.pair).toLowerCase(), virtual_in_curve: Number(ethers.formatEther(reserveVirtual)),
      tokens_left: Number(ethers.formatEther(reserveToken)), graduates_at: Number(ethers.formatEther(threshold)),
      progress_pct: Math.min(100, Math.round(Number(sold * 10000n / toSell)) / 100),
      buy_tax_pct: Number(buyTax), sell_tax_pct: Number(sellTax),
    };
  }
  return out;
}

/**
 * Which Base launchpad made a token: { launchpad, name, state, link, source, ... },
 * or { launchpad: null } when none of these did. Identity is cached a day
 * (it never changes); a Virtuals curve's state, two minutes.
 */
async function identify(chain, token) {
  if (chain !== 'base' || !/^0x[0-9a-f]{40}$/.test(String(token))) return { launchpad: null };
  const who = await cached(`launchpad:id:${token}`, 86400, async () => {
    const [c, z, v] = await Promise.all([
      tryCall(ADDR.clanker, CLANKER, 'deploymentInfoForToken', [token]),
      tryCall(ADDR.zora, ZORA, 'getVersionForDeployedCoin', [token]),
      tryCall(ADDR.bonding, BONDING, 'tokenInfo', [token]),
    ]);
    if (c && String(c.token).toLowerCase() === token) return { launchpad: 'clanker', hook: String(c.hook).toLowerCase(), locker: String(c.locker).toLowerCase() };
    if (z && Number(z[0]) > 0) return { launchpad: 'zora', version: Number(z[0]) };
    if (v && String(v.token).toLowerCase() === token) return { launchpad: 'virtuals' };
    return { launchpad: null };
  });
  if (who.launchpad === 'clanker') {
    return { ...who, name: 'Clanker', state: 'pool', link: LINKS.clanker(token), source: SOURCE.clanker,
      facts: ['Launched by Clanker: its pool is on Uniswap v4, and the liquidity was put in Clanker\'s locker at launch.'] };
  }
  if (who.launchpad === 'zora') {
    return { ...who, name: 'Zora', state: 'pool', link: LINKS.zora(token), source: SOURCE.zora,
      facts: [`A Zora coin (version ${who.version}): it trades on Uniswap v4 from launch.`] };
  }
  if (who.launchpad === 'virtuals') return cached(`launchpad:virtuals:${token}`, 120, () => virtualsCurve(token));
  return { launchpad: null };
}

/** What a buy of amountIn VIRTUAL on the curve gives now, after the launchpad's buy tax. */
async function curveBuyQuote(token, amountIn, buyTaxPct) {
  const net = amountIn - amountIn * BigInt(buyTaxPct) / 100n;
  return BigInt((await call(ADDR.frouter, FROUTER, 'getAmountsOut', [token, VIRTUAL, net]))[0]);
}

/** What selling amountIn of the token on the curve gives now, in VIRTUAL, after the launchpad's sell tax. */
async function curveSellQuote(token, amountIn, sellTaxPct) {
  const out = BigInt((await call(ADDR.frouter, FROUTER, 'getAmountsOut', [token, ZERO, amountIn]))[0]);
  return out - out * BigInt(sellTaxPct) / 100n;
}

/** The newest tokens launched on Virtuals' curve, read from Bonding (newest first). */
async function newestOnCurve(n = 10) {
  return cached('launchpad:virtuals:newest', 120, async () => {
    // The list's length isn't exposed: find it by doubling, then halving.
    const exists = async i => !!(await tryCall(ADDR.bonding, BONDING, 'tokenInfos', [i]));
    let lo = 0, hi = 1;
    while (await exists(hi)) { lo = hi; hi *= 2; if (hi > 1e7) break; }
    while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (await exists(m)) lo = m; else hi = m; }
    const out = [];
    for (let i = lo; i >= 0 && out.length < n && i > lo - n * 3; i--) {
      const t = await tryCall(ADDR.bonding, BONDING, 'tokenInfos', [i]);
      if (!t) continue;
      const v = await virtualsCurve(String(t[0]).toLowerCase()).catch(() => null);
      if (v?.state === 'curve') out.push({ token: String(t[0]).toLowerCase(), ...v });
    }
    return out;
  });
}

module.exports = { identify, virtualsCurve, curveBuyQuote, curveSellQuote, newestOnCurve, BONDING, ADDR, VIRTUAL, LINKS };

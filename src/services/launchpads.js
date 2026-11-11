/**
 * Launchpads, each recognised by its own contract onchain (addresses
 * confirmed against verified source on Sourcify and their code onchain,
 * 11 November 2026). On Base:
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
 * On BNB Chain:
 *
 *   four.meme     TokenManager2 0x5c952063c7fc8610FFDB798152D69F0B9550762b (an ERC1967 proxy, verified
 *                 on Sourcify; its implementation isn't, so every function RektBull calls was matched
 *                 against the implementation's code onchain and run on a copy of BNB Chain) and its
 *                 helper TokenManagerHelper3 0xF251F83e40a78868FcfA3FA4599Dad6494E46034 (also a
 *                 proxy). getTokenInfo(token) names a four.meme token's manager, the asset it's
 *                 priced in, and how much of its curve is sold; tryBuy and trySell quote the curve.
 *                 A token is bought with buyTokenAMAP (BNB in, a minimum out) and sold with
 *                 sellToken, which can pay an integrator's fee (at most 5%) from the sale in the
 *                 same call. Once it raises its target it graduates to PancakeSwap, the same token.
 *
 * identify() is what the Launches desk and the Trade desk read: which
 * launchpad, and for a curve launchpad whether the token is still on its curve.
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
  fourmeme: 'four.meme\'s TokenManagerHelper3 contract onchain (getTokenInfo)',
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

const FOURMEME = {
  tokenManager: '0x5c952063c7fc8610ffdb798152d69f0b9550762b',
  helper: '0xf251f83e40a78868fcfa3fa4599dad6494e46034',
};
const TOKEN_MANAGER = new ethers.Interface([
  'function buyTokenAMAP(address token, uint256 funds, uint256 minAmount) payable',
  'function sellToken(uint256 origin, address token, uint256 amount, uint256 minFunds)',
  'function sellToken(uint256 origin, address token, uint256 amount, uint256 minFunds, uint256 feeRate, address feeRecipient)',
  'function _tokenCount() view returns (uint256)',
  'function _tokens(uint256) view returns (address)',
]);
const HELPER = new ethers.Interface([
  'function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)',
  'function tryBuy(address token, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)',
  'function trySell(address token, uint256 amount) view returns (address tokenManager, address quote, uint256 funds, uint256 fee)',
]);
/** four.meme's sellToken refuses an integrator fee above 5% ('FR'), checked on a copy of BNB Chain. */
const FOURMEME_MAX_FEE_BPS = 500;
/** four.meme's sellToken takes only whole multiples of this many of a token's smallest units ('GW' otherwise; checked on a copy of BNB Chain). */
const FOURMEME_SELL_UNIT = 10n ** 9n;

async function call(to, iface, fn, args = [], chain = 'base') {
  const raw = await rpc.evmRpc(chain, 'eth_call', [{ to, data: iface.encodeFunctionData(fn, args) }, 'latest']);
  return iface.decodeFunctionResult(fn, raw);
}
const tryCall = (...a) => call(...a).catch(() => null);
const bsc = (to, iface, fn, args) => call(to, iface, fn, args, 'bsc');
const ZERO = '0x0000000000000000000000000000000000000000';

const LINKS = {
  clanker: t => `https://clanker.world/clanker/${t}`,
  zora: t => `https://zora.co/coin/base:${t}`,
  virtuals: t => `https://app.virtuals.io/prototypes/${t}`,
  fourmeme: t => `https://four.meme/token/${t}`,
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
      in_curve: Number(ethers.formatEther(reserveVirtual)), in_curve_symbol: 'VIRTUAL',
      tokens_left: Number(ethers.formatEther(reserveToken)), graduates_at: Number(ethers.formatEther(threshold)),
      progress_pct: Math.min(100, Math.round(Number(sold * 10000n / toSell)) / 100),
      buy_tax_pct: Number(buyTax), sell_tax_pct: Number(sellTax),
    };
  }
  return out;
}

const SYMBOL = new ethers.Interface(['function symbol() view returns (string)']);
const pct = (part, whole) => (whole > 0n ? Math.min(100, Math.round(Number(part * 10000n / whole)) / 100) : 0);

/**
 * A four.meme token's curve, read now from four.meme's helper contract, or null when four.meme
 * didn't make it. Its trading fee (1% now) is charged on buys and on sells.
 */
async function fourMemeCurve(token) {
  const info = await bsc(FOURMEME.helper, HELPER, 'getTokenInfo', [token]);
  const manager = String(info.tokenManager).toLowerCase();
  if (manager === ZERO) return null;
  const quote = String(info.quote).toLowerCase();
  const quoteSymbol = quote === ZERO ? 'BNB' : (await tryCall(quote, SYMBOL, 'symbol', [], 'bsc'))?.[0] || quote;
  const out = {
    launchpad: 'fourmeme', name: 'four.meme', version: Number(info.version), token_manager: manager,
    quote: quote === ZERO ? 'bnb' : quote, quote_symbol: quoteSymbol,
    state: info.liquidityAdded ? 'graduated' : 'curve',
    link: LINKS.fourmeme(token), source: SOURCE.fourmeme,
  };
  const fee = Number(info.tradingFeeRate) / 100;
  if (out.state === 'curve') {
    const [maxOffers, offers] = [BigInt(info.maxOffers), BigInt(info.offers)];
    out.curve = {
      in_curve: Number(ethers.formatEther(info.funds)), in_curve_symbol: quoteSymbol, graduates_at: Number(ethers.formatEther(info.maxFunds)),
      tokens_left: Number(ethers.formatEther(offers)),
      progress_pct: pct(maxOffers > offers ? maxOffers - offers : 0n, maxOffers),
      buy_tax_pct: fee, sell_tax_pct: fee, min_fee: Number(ethers.formatEther(info.minTradingFee)), min_fee_wei: String(info.minTradingFee),
    };
  } else {
    out.facts = [`Graduated from four.meme's bonding curve: it now trades on PancakeSwap, the same token, through 0x.`];
  }
  return out;
}

/**
 * Which launchpad made a token: { launchpad, name, state, link, source, ... },
 * or { launchpad: null } when none RektBull reads did. Base: Clanker, Zora,
 * Virtuals; BNB Chain: four.meme. Identity is cached a day (it never
 * changes); a curve's state, two minutes.
 */
async function identify(chain, token) {
  if (!/^0x[0-9a-f]{40}$/.test(String(token))) return { launchpad: null };
  if (chain === 'bsc') {
    const who = await cached(`launchpad:id:bsc:${token}`, 86400, async () => {
      const info = await bsc(FOURMEME.helper, HELPER, 'getTokenInfo', [token]);
      return String(info.tokenManager).toLowerCase() === ZERO ? { launchpad: null } : { launchpad: 'fourmeme' };
    });
    if (who.launchpad !== 'fourmeme') return { launchpad: null };
    return cached(`launchpad:fourmeme:${token}`, 120, async () => (await fourMemeCurve(token)) || { launchpad: null });
  }
  if (chain !== 'base') return { launchpad: null };
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

/** What `funds` BNB buys on a four.meme curve now, after four.meme's fee: { amount, msgValue }. */
async function fourMemeBuyQuote(token, funds) {
  const r = await bsc(FOURMEME.helper, HELPER, 'tryBuy', [token, 0n, funds]);
  return { amount: BigInt(r.estimatedAmount), msgValue: BigInt(r.amountMsgValue), manager: String(r.tokenManager).toLowerCase() };
}

/** What selling `amount` on a four.meme curve gives now, in BNB after four.meme's fee: { funds, fee }. */
async function fourMemeSellQuote(token, amount) {
  const r = await bsc(FOURMEME.helper, HELPER, 'trySell', [token, amount]);
  return { funds: BigInt(r.funds), fee: BigInt(r.fee) };
}

/**
 * The newest four.meme tokens still on their curve, priced in BNB, with at least 1% of the curve
 * sold (most new ones never get a single buy), read from TokenManager2's own list (newest first).
 */
async function newestOnFourMeme(n = 10, scan = 80) {
  return cached('launchpad:fourmeme:newest', 120, async () => {
    const count = Number((await bsc(FOURMEME.tokenManager, TOKEN_MANAGER, '_tokenCount'))[0]);
    const idx = Array.from({ length: Math.min(scan, count) }, (_, i) => count - 1 - i);
    const out = new Array(idx.length).fill(null);
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < idx.length) {
        const k = next++;
        const t = String((await tryCall(FOURMEME.tokenManager, TOKEN_MANAGER, '_tokens', [idx[k]], 'bsc'))?.[0] || '').toLowerCase();
        if (!t) continue;
        const c = await fourMemeCurve(t).catch(() => null);
        if (c?.state === 'curve' && c.quote === 'bnb' && c.curve.progress_pct >= 1) {
          const sym = (await tryCall(t, SYMBOL, 'symbol', [], 'bsc'))?.[0];
          out[k] = { token: t, ticker: sym || '?', ...c };
        }
      }
    }));
    return out.filter(Boolean).slice(0, n);
  });
}

module.exports = {
  identify, virtualsCurve, curveBuyQuote, curveSellQuote, newestOnCurve, BONDING, ADDR, VIRTUAL, LINKS,
  fourMemeCurve, fourMemeBuyQuote, fourMemeSellQuote, newestOnFourMeme, FOURMEME, TOKEN_MANAGER, HELPER, FOURMEME_MAX_FEE_BPS, FOURMEME_SELL_UNIT,
};

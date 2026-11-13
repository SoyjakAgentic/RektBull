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
 *   Virtuals      Virtuals' current launchpad (their docs' contract-addresses page, checked 13 November
 *                 2026): BondingV5 0x1A540088125d00dD3990f9dA45CA0859af4d3B01 (a proxy to
 *                 contracts/launchpadv2/BondingV5.sol) and FRouterV3 0x02FE8eC3d9BBf7318eb54590bcC39198a8b47deD
 *                 (a proxy to FRouterV3.sol), both verified on Sourcify. Buys and sells as before
 *                 (Bonding.buy / sell, approving the router), with two additions read from the contracts:
 *                 an anti-sniper tax of up to 99% that falls to 0 over 60 seconds, 10 or 98 minutes
 *                 after launch (on buys, sells or both, set per token), and "Project 60 days" tokens,
 *                 whose curve Virtuals' operators can drain (FRouterV3.drainPrivatePool). Each token
 *                 graduates at its own tokenGradThreshold, not while its anti-sniper tax runs.
 *   Virtuals (old) Bonding 0xF66DeA7b3e897cD44A5a231c61B6B4423d613259 (a proxy to Bonding) and
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
const cache = require('../lib/cache');
const { cached } = cache;

const VIRTUAL = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
const ADDR = {
  clanker: '0xe85a59c628f7d27878aceb4bf3b35733630083a9',
  zora: '0x777777751622c0d3258f214f9df38e35bf45baf3',
  // Virtuals' old curve: no launches and no buys in the 30 days to 13 November 2026. Read only to sell
  // tokens still on it (a sale is how a holder gets out); new launches are on BondingV5.
  bonding: '0xf66dea7b3e897cd44a5a231c61b6b4423d613259',
  frouter: '0x8292b43ab73efac11faf357419c38acf448202c5',
  bondingV5: '0x1a540088125d00dd3990f9da45ca0859af4d3b01',
  frouterV3: '0x02fe8ec3d9bbf7318eb54590bcc39198a8b47ded',
};
/** The bonding contract and its router, as pairs: a Virtuals route must name one of these. */
const VIRTUALS_PAIRS = [[ADDR.bondingV5, ADDR.frouterV3], [ADDR.bonding, ADDR.frouter]];
const SOURCE = {
  clanker: 'Clanker\'s factory onchain (deploymentInfoForToken)',
  zora: 'Zora\'s coin factory onchain (getVersionForDeployedCoin)',
  virtuals: 'Virtuals\' BondingV5 contract onchain (tokenInfo, tokenLaunchParams; taxes from its FRouterV3 and factory)',
  virtualsOld: 'Virtuals\' old Bonding contract onchain (tokenInfo)',
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
const BONDING_V5 = new ethers.Interface([
  'function tokenInfo(address) view returns (address creator, address token, address pair, address agentToken, (address token, string name, string _name, string ticker, uint256 supply, uint256 price, uint256 marketCap, uint256 liquidity, uint256 volume, uint256 volume24H, uint256 prevPrice, uint256 lastUpdated) data, string description, string image, string twitter, string telegram, string youtube, string website, bool trading, bool tradingOnUniswap, uint256 applicationId, uint256 initialPurchase, uint256 virtualId, bool launchExecuted)',
  'function tokenInfos(uint256) view returns (address)',
  'function tokenGradThreshold(address) view returns (uint256)',
  'function tokenLaunchParams(address) view returns (uint8 launchMode, uint16 airdropBips, bool needAcf, uint8 antiSniperTaxType, bool isProject60days)',
  'function factory() view returns (address)',
  'function bondingConfig() view returns (address)',
  'function buy(uint256 amountIn, address tokenAddress, uint256 amountOutMin, uint256 deadline) payable returns (bool)',
  'function sell(uint256 amountIn, address tokenAddress, uint256 amountOutMin, uint256 deadline) returns (bool)',
]);
const FFACTORY_V3 = new ethers.Interface(['function buyTax() view returns (uint256)', 'function sellTax() view returns (uint256)', 'function antiSniperBuyTaxStartValue() view returns (uint256)']);
const BONDING_CONFIG = new ethers.Interface(['function getAntiSniperDuration(uint8) view returns (uint256)', 'function appliesAntiSniperOnBuy(uint8) view returns (bool)', 'function appliesAntiSniperOnSell(uint8) view returns (bool)']);
const FPAIR_V2 = new ethers.Interface(['function getReserves() view returns (uint256, uint256)', 'function startTime() view returns (uint256)', 'function taxStartTime() view returns (uint256)']);
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
    link: LINKS.virtuals(token), source: SOURCE.virtualsOld,
    // Virtuals' old contract: sold on, never bought on (see ADDR).
    legacy: true, bonding: ADDR.bonding, frouter: ADDR.frouter,
    // The links the creator gave Virtuals (unchecked here; the token page checks them before showing them).
    links: require('../providers/dexscreener').links({ websites: info.website ? [{ label: 'Website', url: info.website }] : [], socials: [['twitter', info.twitter], ['telegram', info.telegram], ['youtube', info.youtube]].filter(([, u]) => u).map(([type, url]) => ({ type, url })) }),
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

/** The latest block's time, by the chain's own clock (cached 2 seconds): what the router's taxes are worked out against. */
const chainNow = () => cached('launchpad:base:now', 2, async () => Number((await rpc.evmRpc('base', 'eth_getBlockByNumber', ['latest', false])).timestamp));

/**
 * The anti-sniper tax FRouterV3 would charge now on a buy or a sell, in whole percent, worked out the
 * way the router does (_calculateAntiSniperTaxForSide): the factory's start value (99%), falling in a
 * straight line to 0 over the token's duration, counted from the pair's taxStartTime (or startTime);
 * the full start value before trading starts. Capped so the normal tax plus this is at most 99%.
 */
function antiSniperPct({ startTax, duration, applies, taxStart, now, normalTax }) {
  if (!applies || duration === 0) return 0;
  let t = now < taxStart ? startTax : now - taxStart >= duration ? 0 : Math.floor(startTax * (duration - (now - taxStart)) / duration);
  if (normalTax + t > 99) t = 99 - normalTax;
  return t;
}

/** Virtuals' current curve (BondingV5): whether it trades, its taxes now (anti-sniper included), and how far it is towards graduating. */
async function virtualsV5Curve(token) {
  const info = await call(ADDR.bondingV5, BONDING_V5, 'tokenInfo', [token]);
  if (String(info.token).toLowerCase() !== token) return null;
  const params = await call(ADDR.bondingV5, BONDING_V5, 'tokenLaunchParams', [token]);
  const out = {
    launchpad: 'virtuals', name: 'Virtuals', ticker: info.data.ticker, creator: String(info.creator).toLowerCase(),
    state: info.tradingOnUniswap ? 'graduated' : info.trading ? (info.launchExecuted ? 'curve' : 'prelaunch') : 'closed',
    agent_token: info.agentToken && info.agentToken !== ZERO ? String(info.agentToken).toLowerCase() : null,
    link: LINKS.virtuals(token), source: SOURCE.virtuals, version: 5, bonding: ADDR.bondingV5, frouter: ADDR.frouterV3,
    project_60_days: params.isProject60days,
    links: require('../providers/dexscreener').links({ websites: info.website ? [{ label: 'Website', url: info.website }] : [], socials: [['twitter', info.twitter], ['telegram', info.telegram], ['youtube', info.youtube]].filter(([, u]) => u).map(([type, url]) => ({ type, url })) }),
  };
  if (out.state === 'curve' || out.state === 'prelaunch') {
    // The router's own settings: its factory's taxes, and its config's anti-sniper rules (these change rarely: cached 10 minutes).
    const setup = await cached('launchpad:virtuals:v5:setup', 600, async () => {
      const [[factory], [config]] = await Promise.all([call(ADDR.bondingV5, BONDING_V5, 'factory'), call(ADDR.bondingV5, BONDING_V5, 'bondingConfig')]);
      const [[buyTax], [sellTax], [startTax]] = await Promise.all(['buyTax', 'sellTax', 'antiSniperBuyTaxStartValue'].map(fn => call(factory, FFACTORY_V3, fn)));
      return { config: String(config).toLowerCase(), buy_tax: Number(buyTax), sell_tax: Number(sellTax), start_tax: Number(startTax) };
    });
    const type = Number(params.antiSniperTaxType);
    const rules = await cached(`launchpad:virtuals:v5:antisniper:${type}`, 86400, async () => {
      const [[duration], [onBuy], [onSell]] = await Promise.all([
        call(setup.config, BONDING_CONFIG, 'getAntiSniperDuration', [type]), call(setup.config, BONDING_CONFIG, 'appliesAntiSniperOnBuy', [type]), call(setup.config, BONDING_CONFIG, 'appliesAntiSniperOnSell', [type])]);
      return { duration: Number(duration), on_buy: onBuy, on_sell: onSell };
    });
    const [[reserveToken, reserveVirtual], [threshold], [startTime], taxStartRaw, now] = await Promise.all([
      call(info.pair, FPAIR_V2, 'getReserves'), call(ADDR.bondingV5, BONDING_V5, 'tokenGradThreshold', [token]), call(info.pair, FPAIR_V2, 'startTime'),
      tryCall(info.pair, FPAIR_V2, 'taxStartTime'), chainNow()]);
    const taxStart = taxStartRaw && Number(taxStartRaw[0]) > 0 ? Number(taxStartRaw[0]) : Number(startTime);
    const anti = side => antiSniperPct({ startTax: setup.start_tax, duration: rules.duration, applies: side === 'buy' ? rules.on_buy : rules.on_sell, taxStart, now, normalTax: side === 'buy' ? setup.buy_tax : setup.sell_tax });
    const [antiBuy, antiSell] = [anti('buy'), anti('sell')];
    const supply = BigInt(info.data.supply); // the curve's starting reserve
    const sold = supply > reserveToken ? supply - reserveToken : 0n;
    const toSell = supply > threshold ? supply - threshold : 1n;
    const endsAt = rules.duration ? taxStart + rules.duration : null;
    out.curve = {
      pair: String(info.pair).toLowerCase(), virtual_in_curve: Number(ethers.formatEther(reserveVirtual)),
      in_curve: Number(ethers.formatEther(reserveVirtual)), in_curve_symbol: 'VIRTUAL',
      tokens_left: Number(ethers.formatEther(reserveToken)), graduates_at: Number(ethers.formatEther(threshold)),
      progress_pct: Math.min(100, Math.round(Number(sold * 10000n / toSell)) / 100),
      // What a trade pays now, all in: the launchpad's tax plus any anti-sniper tax still running.
      buy_tax_pct: setup.buy_tax + antiBuy, sell_tax_pct: setup.sell_tax + antiSell,
      normal_buy_tax_pct: setup.buy_tax, normal_sell_tax_pct: setup.sell_tax,
      anti_sniper: { buy_pct: antiBuy, sell_pct: antiSell, on_buy: rules.on_buy, on_sell: rules.on_sell, duration_s: rules.duration, ends_at: endsAt && endsAt > now ? new Date(endsAt * 1000).toISOString() : null, starts_at: now < taxStart ? new Date(taxStart * 1000).toISOString() : null, source: 'FRouterV3\'s anti-sniper rule (its factory\'s start value, the token\'s type from BondingConfig), worked out by the chain\'s clock' },
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
    const [c, z, v5, v] = await Promise.all([
      tryCall(ADDR.clanker, CLANKER, 'deploymentInfoForToken', [token]),
      tryCall(ADDR.zora, ZORA, 'getVersionForDeployedCoin', [token]),
      tryCall(ADDR.bondingV5, BONDING_V5, 'tokenInfo', [token]),
      tryCall(ADDR.bonding, BONDING, 'tokenInfo', [token]),
    ]);
    if (c && String(c.token).toLowerCase() === token) return { launchpad: 'clanker', hook: String(c.hook).toLowerCase(), locker: String(c.locker).toLowerCase() };
    if (z && Number(z[0]) > 0) return { launchpad: 'zora', version: Number(z[0]) };
    if (v5 && String(v5.token).toLowerCase() === token) return { launchpad: 'virtuals', version: 5 };
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
  // A V5 curve's taxes change by the second while its anti-sniper tax runs: read again after 10 seconds, else 2 minutes.
  if (who.launchpad === 'virtuals' && who.version === 5) {
    const key = `launchpad:virtuals:v5:${token}`;
    const hit = await cache.get(key);
    if (hit) return hit;
    const v = await virtualsV5Curve(token);
    if (v) await cache.set(key, v, v.curve?.anti_sniper?.ends_at || v.curve?.anti_sniper?.starts_at ? 10 : 120);
    return v || { launchpad: null };
  }
  if (who.launchpad === 'virtuals') return cached(`launchpad:virtuals:${token}`, 120, () => virtualsCurve(token));
  return { launchpad: null };
}

/** The tax a router takes from an amount: the launchpad's tax and any anti-sniper tax, each rounded down on its own, as FRouterV3 does. */
const taxed = (amount, pad, side) => {
  const a = pad?.curve?.anti_sniper;
  if (!a) return amount - amount * BigInt(pad.curve[`${side}_tax_pct`]) / 100n;
  return amount - amount * BigInt(pad.curve[`normal_${side}_tax_pct`]) / 100n - amount * BigInt(a[`${side}_pct`]) / 100n;
};

/** What a buy of amountIn VIRTUAL on the token's curve gives now, after its taxes (pad: what identify() read). */
async function curveBuyQuote(token, amountIn, pad) {
  return BigInt((await call(pad.frouter || ADDR.frouter, FROUTER, 'getAmountsOut', [token, VIRTUAL, taxed(amountIn, pad, 'buy')]))[0]);
}

/** What selling amountIn of the token on its curve gives now, in VIRTUAL, after its taxes. */
async function curveSellQuote(token, amountIn, pad) {
  return taxed(BigInt((await call(pad.frouter || ADDR.frouter, FROUTER, 'getAmountsOut', [token, ZERO, amountIn]))[0]), pad, 'sell');
}

/** The newest tokens launched on Virtuals' current curve, read from BondingV5's own list (newest first). */
async function newestOnCurve(n = 10) {
  return cached('launchpad:virtuals:v5:newest', 120, async () => {
    // The list's length isn't exposed: find it by doubling, then halving.
    const exists = async i => !!(await tryCall(ADDR.bondingV5, BONDING_V5, 'tokenInfos', [i]));
    if (!(await exists(0))) return [];
    let lo = 0, hi = 1;
    while (await exists(hi)) { lo = hi; hi *= 2; if (hi > 1e7) break; }
    while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (await exists(m)) lo = m; else hi = m; }
    const out = [];
    for (let i = lo; i >= 0 && out.length < n && i > lo - n * 3; i--) {
      const t = await tryCall(ADDR.bondingV5, BONDING_V5, 'tokenInfos', [i]);
      if (!t) continue;
      const v = await virtualsV5Curve(String(t[0]).toLowerCase()).catch(() => null);
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
  identify, virtualsCurve, virtualsV5Curve, antiSniperPct, curveBuyQuote, curveSellQuote, newestOnCurve, BONDING, BONDING_V5, ADDR, VIRTUALS_PAIRS, VIRTUAL, LINKS,
  fourMemeCurve, fourMemeBuyQuote, fourMemeSellQuote, newestOnFourMeme, FOURMEME, TOKEN_MANAGER, HELPER, FOURMEME_MAX_FEE_BPS, FOURMEME_SELL_UNIT,
};

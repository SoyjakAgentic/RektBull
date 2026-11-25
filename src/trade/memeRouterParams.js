/**
 * The Meme Router's constructor arguments per chain (contracts/contracts/RektBullMemeRouter.sol,
 * docs/MEME_ROUTER.md "Deployment"). The router can't be changed once deployed: its exchanges
 * (venues) and the assets it takes its fee in (bases) are fixed in it. So this one list is read by
 * the checks on copies of each chain (contracts/scripts/memeRouter*Check.js), by the order service
 * (trade/memeOrders.js, which checks the deployed router against it), and by the deployment.
 *
 *   venues  contracts a fill may call or approve: 0x's AllowanceHolder everywhere; four.meme's
 *           TokenManager2 on BNB Chain; Virtuals' BondingV5 (called) and FRouterV3 (approved) on Base.
 *           Virtuals' old Bonding isn't one: nothing launches or is bought on it (13 November 2026),
 *           and holders still sell there from their own wallet on the Trade desk.
 *   bases   what the fee is taken in when it's the output, and what orders are priced in: the
 *           wrapped native coin and the stablecoins, and on Base, VIRTUAL (a Virtuals curve trades in it).
 */
const { TRADE_CHAINS } = require('./chains');
const lp = require('../services/launchpads');

const FEE_BPS = 100; // 1%: the router's own cap (MAX_FEE_BPS)

const PARAMS = {
  base: {
    chainId: 8453,
    wrapped: TRADE_CHAINS.base.bases.WETH.address,
    venues: [TRADE_CHAINS.base.allowanceHolder, lp.ADDR.bondingV5, lp.ADDR.frouterV3],
    bases: [TRADE_CHAINS.base.bases.WETH.address, TRADE_CHAINS.base.bases.USDC.address, lp.VIRTUAL],
    // Virtuals' BondingV5 and FRouterV3 are upgradeable proxies: their admin can replace the code. These are the
    // implementations checked on a copy of Base (contracts/scripts/memeRouterVirtualsCheck.js, 25 November 2026). The
    // order service reads them again (EIP-1967) and stops routing orders on Virtuals curve coins if either changes,
    // until the new code is reviewed and these are updated. The router can't lose a user's coins to an upgrade (it
    // approves a venue only for a fill's own input, and checks what reaches the user), but fills could misbehave.
    implementations: {
      [lp.ADDR.bondingV5]: '0x20c124e13069889633fc4212e0797c95cb30db40',
      [lp.ADDR.frouterV3]: '0x58377381523e86d66f9f29016371335ddcb89d32',
    },
  },
  bsc: {
    chainId: 56,
    wrapped: TRADE_CHAINS.bsc.bases.WBNB.address,
    venues: [TRADE_CHAINS.bsc.allowanceHolder, lp.FOURMEME.tokenManager],
    bases: [TRADE_CHAINS.bsc.bases.WBNB.address, TRADE_CHAINS.bsc.bases.USDT.address, TRADE_CHAINS.bsc.bases.USDC.address],
  },
};

/** The constructor's arguments, in its order: (feeWallet, feeBps, wrappedNative, venues, baseAssets). */
const constructorArgs = (chain, feeWallet) => {
  const p = PARAMS[chain];
  if (!p) throw new Error(`no Meme Router parameters for ${chain}`);
  return [feeWallet, FEE_BPS, p.wrapped, p.venues, p.bases];
};

module.exports = { PARAMS, FEE_BPS, constructorArgs };

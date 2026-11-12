# The Launches desk: meme coins, checked before you trade them

A trading front end over new tokens and launchpads, with RektBull's checks in
front of every buy and agents watching after it. The user's wallet signs
every trade; RektBull never holds funds or keys. Nothing on it is financial
advice.

## Phase 1: built

- **The feed** (`/launches`, `GET /v1/launches?chain=`): the newest pools on
  Base, Ethereum, Arbitrum and (from phase 3) BNB Chain (GeckoTerminal), newest first, with the warning
  signs their own trading shows and GoPlus's flags for the newest 8 (cached 6
  hours). Free.
- **A token's card** (`GET /v1/launches/:chain/:token`): its market
  (DexScreener), GoPlus's flags, and its age. Free.
- **Buying and selling** goes through the Trade desk (0x routes it across
  exchanges; 1% fee inside the swap; the wallet signs). Before a buy:
  - RektBull's full token check, as on every trade;
  - **for a token under a week old, the bundle and insider check** (Launch
    Safety), free inside a trade: a critical finding stops the buy; a high one
    needs the buyer to confirm they've read it; a check that couldn't run
    needs confirming too.
- **Meme Watch** (an AI agent, free): watches up to 10 tokens the account
  bought through RektBull, every hour or 6 hours: launch-bundle wallets
  selling (balances re-read every 6 hours), a new GoPlus flag, liquidity down
  half or more since the last check, and the take-profit and stop-loss from
  the Trade desk's settings. Each alert links a sell of the whole position on
  the Trade desk, already checked, for the wallet to review and sign. It never
  sells by itself.

## Phase 2: built (Base launchpads)

Each launchpad is recognised by its own contract, read onchain
(`src/services/launchpads.js`); every address was checked against its
verified source on Sourcify and its code onchain on 11 November 2026:

| Launchpad | Contract | How a token is recognised | How it trades |
|---|---|---|---|
| Clanker (v4) | factory `0xE85A59c628F7d27878ACeB4bf3b35733630083a9` (`src/Clanker.sol:Clanker`) | `deploymentInfoForToken(token)` names its hook and LP locker | Uniswap v4 from launch, through 0x |
| Zora coins | `0x777777751622c0d3258f214F9DF38E35BF45baF3` (ZoraFactory, a proxy to ZoraFactoryImpl) | `getVersionForDeployedCoin(coin)` | Uniswap v4 from launch, through 0x |
| Virtuals | Bonding `0xF66DeA7b3e897cD44A5a231c61B6B4423d613259` and FRouter `0x8292B43aB73EfAC11FAF357419C38ACF448202C5` (proxies to Bonding and FRouter); priced in VIRTUAL `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b` | `Bonding.tokenInfo(token)` | its bonding curve until it graduates to Uniswap (as a new agent token) |

- **The feed** names each Base token's launchpad, and a new section lists
  the newest tokens still on Virtuals' curve, with how far each is to
  graduating (125M tokens left on the curve), read from Bonding.
- **Buying on Virtuals' curve:** the wallet signs, in one batch where it can:
  the base asset (USDC, ETH) swapped into VIRTUAL through 0x (RektBull's 1%
  fee is taken inside that swap, as on every trade), an approval of VIRTUAL to
  Virtuals' FRouter for exactly that amount, and `Bonding.buy` with a minimum
  out. The curve's own tax is 1% to buy and 1% to sell, read from its factory.
  Checks before it: the bundle check (a token on a curve is always new), the
  launchpad's taxes against the buyer's limit, and selling straight back on
  the curve against their round-trip limit. The token was created by
  Virtuals' Bonding contract, so its code is Virtuals' template.
- **Selling:** an approval of the token to FRouter, `Bonding.sell` with a
  minimum in VIRTUAL, then that minimum swapped back into the base asset
  through 0x (the 1% fee inside). Any VIRTUAL above the minimum stays in the
  wallet.
- **Graduated tokens:** a curve token that graduated is refused, naming the
  agent token that replaced it; Meme Watch tells its holders once.
- Verified on a copy of Base (`contracts/scripts/curveCheck.js`): a 50 VIRTUAL
  buy got exactly the quoted amount, a minimum the curve can't meet was
  refused by Virtuals' contract, and selling it all back returned 49.005
  VIRTUAL (the two 1% taxes).

## Phase 3: built (BNB Chain and four.meme)

- **BNB Chain on the Trade desk** (`src/trade/chains.js`, chain `bsc`, 56):
  approve-each trades through 0x, paying with USDT (the default), USDC, BNB
  or WBNB. 0x's AllowanceHolder is at the same address as on Base (its code
  checked onchain). BNB Chain's USDT and USDC use 18 decimals (read onchain).
  There's no Trade Router on BNB Chain: no automatic trading there. A wallet
  that doesn't have BNB Chain yet is asked to add it.
- **The feed** covers BNB Chain and names four.meme tokens, read from
  four.meme's own contract. Most four.meme tokens only get a pool once they
  graduate, so the curve section lists the newest ones still on the curve
  (priced in BNB, at least 1% sold), with how much BNB they've raised against
  their target, read from TokenManager2.
- **four.meme's contracts** (BNB Chain, 11 November 2026):

  | Contract | Address | How it was checked |
  |---|---|---|
  | TokenManager2 | `0x5c952063c7fc8610FFDB798152D69F0B9550762b` | The ERC1967 proxy is verified on Sourcify; its implementation (`0xa38D9d48…2E72`) isn't, so each function RektBull calls (`buyTokenAMAP`, both `sellToken`s, `_tokenCount`, `_tokens`) was matched against the implementation's code onchain and run on a copy of BNB Chain |
  | TokenManagerHelper3 | `0xF251F83e40a78868FcfA3FA4599Dad6494E46034` | Also a proxy, verified on Sourcify; `getTokenInfo`, `tryBuy` and `trySell` matched against its implementation's code and read live |

  `getTokenInfo(token)` returns zeros for a token four.meme didn't make, so
  that's how a token is recognised. Tokens four.meme prices in something other
  than BNB (10 of the newest 40 when checked, priced in tokens such as QQQB), and
  tokens on its older TokenManager, are refused, naming why.
- **Buying on four.meme's curve:** the wallet signs, in one batch where it
  can: USDT or USDC swapped into BNB through 0x (RektBull's 1% fee inside that
  swap, as on every trade), then `buyTokenAMAP` with exactly the least BNB that
  swap delivers and a minimum out. four.meme's own fee is 1% each way, read
  from its helper. Checks before it: the bundle check, four.meme's fees
  against the buyer's tax limit, and selling straight back on the curve
  against their round-trip limit.
- **Buying with BNB:** there is no swap to carry RektBull's fee, so
  `buyTokenAMAP` spends 99% of the BNB and the other 1% is a plain transfer to
  the fee wallet after it, in the same batch (`atomicRequired`), as claim fees
  are (docs/PAYMENTS.md). A wallet that can't batch sends the buy first, then
  the fee, which the user can decline. Paying with WBNB is refused.
- **Selling:** an approval of the token to TokenManager2, then `sellToken`
  with a minimum in BNB and RektBull's 1% as four.meme's integrator fee to the
  fee wallet. four.meme's contract pays it from the sale in the same call, so
  it's paid only if the sale goes through, and it refuses any fee above 5%.
  `sellToken` checks its minimum before that fee comes off, so the plan
  promises the minimum less the most the fee can be. For USDT or USDC, that
  promised BNB is then swapped through 0x with no second fee. Before the fee
  wallet is set, the plain `sellToken` is used and no fee is taken. A sale
  never applies the buy checks. four.meme sells only whole multiples of 10^9
  of a token's smallest units (it reverts with `GW` otherwise, found on a copy
  of BNB Chain), so a sale is rounded down to one; what's left is under a
  billionth of a token.
- **Graduated tokens** trade on PancakeSwap, the same token, so they go
  through 0x with the full token check. Meme Watch tells holders once.
- Verified on a copy of BNB Chain (`contracts/scripts/fourMemeCheck.js`):
  0.1 BNB bought exactly the quoted amount, a minimum the curve can't meet was
  refused by four.meme's contract, a sale with the fee paid the fee wallet
  exactly 1% of the sale and the wallet more than the plan promised, a sale of
  an amount that isn't a multiple of 10^9 units was refused (`GW`), a sale
  without the fee paid the wallet the whole quote, and a buy paid in BNB got
  exactly its quote with exactly 1% to the fee wallet.
- **Limits:** the bundle check reads BNB Chain through Etherscan's API, whose
  free plan may not cover it; when it can't run, the buyer is told why and
  must confirm. BNB Chain has heavy sandwich trading: the slippage limit (1% by
  default) bounds what a sandwich can take.

## Phases to come

4. **Solana and pump.fun:** trades the user signs with Phantom, through
   Jupiter. Needs a reliable Solana data source first: the free public RPC
   rate-limits the bundle check. A paid RPC such as QuickNode (a month's free
   trial) or Helius (about $50 a month) goes in `RPC_URLS_SOLANA`.
5. **The Meme Router:** automatic meme trading. *Contract and break-it tests
   built, not audited: [MEME_ROUTER.md](MEME_ROUTER.md). It bounds each fill by
   the price the user signed instead of a TWAP.* The original plan: The audited Trade Router
   trades only tokens with a Chainlink price, which meme coins don't have, and
   that price bound is what stops a hacked RektBull from selling a user's
   tokens at a bad price. A Meme Router would bound each trade another way
   (an exchange TWAP, small per-trade and per-day limits the user signs, output
   only to the user), and must be audited before it holds anything. Until
   then, the meme agent alerts and prepares trades; the user signs.

## Never

- Holding a user's funds or keys, or signing for them outside a permission
  their wallet signed onchain.
- First-block sniping: that needs keys held on a server.
- Calling a token safe, or recommending one.

# The Launches desk: meme coins, checked before you trade them

A trading front end over new tokens and launchpads, with RektBull's checks in
front of every buy and agents watching after it. The user's wallet signs
every trade; RektBull never holds funds or keys. Nothing on it is financial
advice.

## Phase 1: built

- **The feed** (`/launches`, `GET /v1/launches?chain=`): the newest pools on
  Base, Ethereum and Arbitrum (GeckoTerminal), newest first, with the warning
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

## Phases to come

3. **BNB Chain and four.meme:** BNB Chain added to trading (0x covers it),
   then four.meme's bonding curve.
4. **Solana and pump.fun:** trades the user signs with Phantom, through
   Jupiter. Needs a reliable Solana data source first: the free public RPC
   rate-limits the bundle check (a paid plan such as Helius, about $50 a month).
5. **The Meme Router:** automatic meme trading. The audited Trade Router
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

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
| Virtuals | BondingV5 `0x1A540088125d00dD3990f9dA45CA0859af4d3B01` and FRouterV3 `0x02FE8eC3d9BBf7318eb54590bcC39198a8b47deD` (proxies, verified on Sourcify; the addresses on Virtuals' contract-addresses page); priced in VIRTUAL `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b`. The old Bonding `0xF66DeA7b3e897cD44A5a231c61B6B4423d613259` and FRouter `0x8292B43aB73EfAC11FAF357419C38ACF448202C5`: sold on only (see below) | `BondingV5.tokenInfo(token)`, then the old `Bonding.tokenInfo(token)` | its bonding curve until it graduates to Uniswap |

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

### Virtuals' new launchpad, BondingV5 (13 November 2026)

Virtuals moved launches to BondingV5 with FRouterV3 (their "launchpadv2"). The
old Bonding had no launches and no buys in the 30 days read; BondingV5's last
launch was 54 hours earlier. RektBull reads BondingV5 first:

- **Same calls:** `buy` and `sell` keep their signatures, with an approval to
  FRouterV3. Each token graduates at its own `tokenGradThreshold`, and not while
  its anti-sniper tax runs; a graduated token can be its own agent token, which
  then trades through 0x like any token.
- **Anti-sniper tax:** up to 99% (the factory's start value), falling in a
  straight line to 0 over 60 seconds, 10 or 98 minutes after launch, on buys,
  sells or both by the token's type (`BondingConfig`). RektBull works it out as
  FRouterV3 does (`_calculateAntiSniperTaxForSide`), by the chain's clock, and
  adds it to the taxes: a buy over the user's tax limit is refused saying when it
  ends; a sale goes ahead, saying what it pays. Re-read every 10 seconds while it runs.
- **"Project 60 days" launches:** `FRouterV3.drainPrivatePool` lets Virtuals'
  operators (BE_OPS role) take all the money and tokens from such a curve. A buy
  needs the user to confirm they've read that; the token page and the live
  feed's card say it too.
- **A token not open yet** (made with `preLaunch`, `launchExecuted` false) is
  refused: Virtuals' contract refuses its buys and sells until it launches.
- **The old curve** is only sold on: a buy there is refused, saying why, and
  `calls.js` won't build one; a holder's sale goes through the old pair.
- Verified on a copy of Base (`contracts/scripts/curveCheck.js`, 13 November
  2026): on BondingV5, a 50 VIRTUAL buy got exactly its quote, a minimum the
  curve can't meet was refused, and selling it all back returned 49.005 VIRTUAL;
  on the old Bonding, RektBull refused to build a buy, and a holder's sale built
  by RektBull returned 19.602 VIRTUAL for 20 put in.

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

## The live feed: built (Trade desk, stage 1)

The Live card at the top of `/launches`: three columns that fill in by
themselves, read from the launchpads' own contract events every 10 seconds
while the page is open (`src/services/liveLaunches.js`, `GET /v1/launches/live?chain=base|bsc`).

| Column | Base | BNB Chain |
|---|---|---|
| New (the last hour) | Clanker `TokenCreated`; Zora `CoinCreatedV4`, `CreatorCoinCreated`, `CoinCreated`; Virtuals BondingV5 `Launched` | four.meme `TokenCreate` |
| Nearest to graduating | Virtuals' curves (the newest on BondingV5) | Curves bought in the last hour (four.meme `TokenPurchase`), the ones that raised most, each confirmed with its helper (`getTokenInfo`) |
| Just graduated (24 hours) | Virtuals `Graduated` (bought as its new agent token) | four.meme `LiquidityAdded` |

- **Event layouts:** Clanker's, Zora's and Virtuals' from their verified source
  on Sourcify (implementations for the proxies). four.meme's implementation
  isn't verified: `TokenCreate(address creator, address token, uint256
  requestId, string name, string symbol, uint256 totalSupply, uint256
  launchTime, uint256 launchFee)`, `TokenPurchase(address token, address
  account, uint256 price, uint256 amount, uint256 cost, uint256 fee, uint256
  offers, uint256 funds)` and `LiquidityAdded(address base, uint256 offers,
  address quote, uint256 funds)` were matched by signature against its logs,
  and a decoded launch and graduation checked with its helper (13 November 2026).
- **Cost:** each chain is read at most once every 10 seconds for everyone (the
  result is cached in the database, so every instance shares it), each read
  asks only for the blocks since the last one, and the 24 hours of
  graduations are filled in three chunks per read. After a gap with nobody
  watching, the last hour is read afresh. GoPlus's flags go on the six newest
  launches, asked once per token.
- **Logs:** `providers/rpc.evmLogs` asks your `RPC_URLS_<CHAIN>` first, then
  publicnode's keyless endpoints. The default public RPCs refuse log queries
  (Base's: "request limit reached"; BNB Chain's: "limit exceeded").
- **Seen on 13 November 2026:** about 80 four.meme launches an hour and about
  3 graduations a day; on Base, a few Clanker and Zora launches an hour, and
  few Virtuals launches (BondingV5's last was 54 hours earlier). The feed reads
  BondingV5's events: its `Launched` has a new layout (it carries the launch's
  settings, so a "Project 60 days" card says so).

## Phase 4: built (Solana and pump.fun, Trade desk stage 2)

- **Sign in and trade:** a Solana wallet signs in, or is linked to an EVM
  account; trades are signed in Phantom, Solflare or MetaMask, through
  Jupiter's Router (pump.fun's curve, PumpSwap, Raydium LaunchLab and the
  rest), with RektBull's 1% as a SOL transfer in the same transaction
  (`src/trade/solana.js`, docs/PAYMENTS.md).
- **The Live card on Solana** (`src/services/solanaLaunches.js`): reading
  pump.fun's own events would mean fetching thousands of transactions a
  minute, so the feed reads instead:
  - **New:** GeckoTerminal's newest pools on Solana, two pages every 20
    seconds, kept for an hour: the ones on pump.fun's curve priced in SOL
    (GeckoTerminal's `pump-fun` dex; its pool address is the coin's bonding
    curve, checked against the curve's address derived from the mint). Each
    of the newest six cards says what the mint says: a freeze or mint
    authority still set (Solana RPC, one call).
  - **Nearest to graduating:** the busiest pump.fun curves (GeckoTerminal, by
    transactions in 24 hours, cached a minute) and the new ones, each curve
    read from the chain in one call: how much of the 793.1 million tokens for
    sale is sold, and the SOL in it. That figure is read once a day from
    pump.fun's Global account (offset 89; its fee, 0.95%, at 105). Curves
    priced in other tokens (pump.fun also runs USDC- and coin-priced curves)
    are left out.
  - **Just graduated:** PumpSwap pools, the newest and the day's busiest,
    whose coin's pump.fun curve the chain shows as `complete`.
  - **Cost:** about 2 GeckoTerminal calls every 20 seconds plus 2 a minute
    (its free plan: about 30 a minute), and 2 RPC calls every 20 seconds,
    about 260,000 a month on `RPC_URLS_SOLANA`, shared by every visitor.
  - "Look closer" on a Solana card opens the Safety desk's check (the token
    page reads EVM chains only).
- **Meme Watch on Solana:** positions bought on Solana are watched like the
  rest: liquidity, the stop-loss and take-profit, launch-bundle wallets
  selling; the mint's authorities in place of GoPlus's flags (GoPlus doesn't
  cover Solana here); one alert when the coin's pump.fun curve completes.
- **Seen on 15 November 2026:** pump.fun coins reach GeckoTerminal's new
  pools within seconds; a live read built the three columns in about 2
  seconds (22 new coins, 10 curves, 7 graduations in the day).

### pump.fun's events, streamed (Yellowstone gRPC): built, off until its key is set

Decided by the owner on 23 November 2026: Chainstack's Solana Yellowstone gRPC
add-on ($49 a month), bought before launch. The code takes any Yellowstone
provider; switching is two settings.

- **What it's for.** pump.fun's own events, pushed as the chain confirms them,
  replace the polling above:
  - `CreateEvent`: a new coin, within a second or two, not up to 20 seconds;
  - `TradeEvent`: each curve's progress from its last trade's reserves, with
    no GeckoTerminal "busiest" list and no curve reads;
  - `CompleteEvent` and `CompletePumpAmmMigrationEvent`: a graduation and its
    PumpSwap pool, as it happens.

  The meme picks' watchlist reads the same feed, so it gets graduations sooner
  too. GeckoTerminal's free quota (about 30 calls a minute) is then left for
  the picks.
- **How** (`src/providers/yellowstone.js`, `src/services/pumpStream.js`):
  - **One stream, opened by the worker:** confirmed, successful transactions
    that touch pump.fun's program (`6EF8…F6P`), filtered by the provider.
  - **Decoding:** events are read with the layouts in pump.fun's published IDL
    (github.com/pump-fun/pump-public-docs, `idl/pump.json`). Each is found as
    an Anchor self-CPI event, or a `Program data:` log line. Only the leading
    fields are read, so fields pump.fun adds later don't break it. Curves
    priced in anything but SOL are left out, as in the polled feed.
  - **Sharing:** the worker keeps the state in memory and writes it to the
    shared cache every 2 seconds (every 10 when quiet).
  - **Names:** coins that launched before the stream started get their names
    from DexScreener (30 a call, kept a day).
- **The fallback.** The feed uses the stream only while its state is under 30
  seconds old and the stream is receiving. Otherwise it polls exactly as
  before, and each column names the source it used.
  - The client reconnects by itself, without replay, since polling covers the
    gap. If it gives up, the worker starts it again a minute later.
  - The admin panel's health view shows the stream as live, down or not set.
    "Down" is listed as a problem.
- **Settings:** `YELLOWSTONE_GRPC_URL` (the endpoint, `https://…:443`) and
  `YELLOWSTONE_GRPC_TOKEN` (the access token: a secret, kept in the
  environment's secret settings, never in the repo or a chat). Unset, nothing
  connects.
- **Client:** `@triton-one/yellowstone-grpc` 10.0.0 (Triton One, Yellowstone's
  authors; Apache-2.0). It uses a prebuilt native module for Linux x64, so the
  server image must be Linux x64 (glibc or musl) or macOS.
- **Volume to watch:** pump.fun's busiest hours are hundreds of transactions a
  second. The filter keeps only pump.fun's, but check the add-on's limits on
  streams and bandwidth when it's bought.
- **Next uses, not built yet:**
  - Meme Watch on Solana: launch-bundle and insider wallets selling, within
    seconds instead of every 6 hours (a filter on those wallets).
  - A Solana Wallet Tracker: following wallets' buys and sells, as on the EVM
    chains.

## AI picks: built (meme coin proposals)

Coins RektBull's rules pick from the busiest pools on Base, BNB Chain and
Solana, after its safety checks, with Haiku's short explanation of the facts.
There's a public scorecard at 1 hour and 24 hours. Picks are free; acting on
one opens the Trade desk, and the trade has the usual 1% fee.
[MEME_PROPOSALS.md](MEME_PROPOSALS.md).

## Phases to come

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
- Calling a token safe, or recommending one. An AI pick is what stated rules
  found, shown with the rules and a public scorecard, never as advice
  (MEME_PROPOSALS.md).

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

GeckoTerminal shows Clanker and Zora coins as Uniswap v4 pools, so the feed
names the exchange, not the launchpad. Naming the launchpad needs each
launchpad's factory contract, confirmed onchain; that comes with phase 2.

## Phases to come

2. **Base launchpads' bonding curves:** buying tokens still on Virtuals' and
   Zora's curves (a direct call to the launchpad's contract, not 0x), and
   naming each token's launchpad in the feed. Each contract confirmed onchain
   first; the fee is a separate transfer the wallet signs next to the trade.
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

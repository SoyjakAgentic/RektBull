# Wallet Tracker (Trade desk, stage 3)

Follow any wallets on Base, Ethereum, Arbitrum and BNB Chain. When one buys or
sells a token, an alert arrives within seconds (Telegram, email or browser
notification), with RektBull's token check (and, for a token under a week old,
the bundle check) already run, and the buy ready on the Trade desk for the
user's own wallet to sign. RektBull never trades from an alert.

- **Where:** the "Wallets you follow" card on `/launches#follow-card`; the
  agent's page is `/agents/wallet-tracker`; its switch is on `/agents`.
- **Price:** following up to 5 wallets is free for any signed-in wallet; Safety
  Pro follows up to 25 (`SAFETY_PRO.follow.wallets`). Trades carry the usual 1%.
- **Code:** `src/services/walletTracker.js`, the worker job `wallet_tracker`
  (every 5 seconds; the `alerts` job now also runs every 5 seconds),
  `public/follow.js`, migration `025_wallet_tracker.sql`.
- **API:** `GET /v1/wallet-tracker`, `POST /v1/wallet-tracker/wallets`
  `{ address, label }`, `DELETE /v1/wallet-tracker/wallets/:id` (signed in).

## How a trade is seen

Every 5 seconds, for each chain, two `eth_getLogs` calls ask for the ERC-20
`Transfer` events from and to any followed wallet (everyone's wallets in the
same calls, 100 to a call) in the blocks since the last read. Per transaction
and wallet:

| What the logs show | Counted as | Extra lookup |
| --- | --- | --- |
| A token in and something out (a swap) | A buy of what came in, a sale of what went out | None |
| Only a token in | A buy, only if the wallet sent the transaction and paid ETH or BNB with it | The transaction |
| Only a token out | A sale, only if the wallet sent it and ETH or BNB came back: the router unwrapping WETH or WBNB (its `Withdrawal`, which also gives the amount), or four.meme's curve paying out | The receipt |
| A token minted to the wallet or burnt from it | Not a trade (liquidity, vault or pool shares, a loan or its repayment) | None |

ETH, WETH, BNB, WBNB, the main stablecoins and VIRTUAL are what trades are paid
in (`QUOTE`), never reported as the thing traded. Each trade's worth is worked
out from what was paid or received (DefiLlama prices), or else from the token's
own price; "not priced" is shown as no dollar figure, never a guess.

**Not seen:** a trade paid in ETH from a smart-contract wallet (sent by a
bundler); a sale into a pool that pays native ETH without WETH (some Uniswap v4
pools).

## Solana (built 23 November 2026, with the Yellowstone stream)

`src/services/solanaTracker.js`.
- **Only with the stream.** Followed Solana wallets ride the one Yellowstone
  subscription ([LAUNCHES.md](LAUNCHES.md)) as filters of 200, ahead of Meme
  Watch's insider wallets, which get the room left. There's no affordable way
  to poll Solana wallets, so while the stream isn't set up
  (`YELLOWSTONE_GRPC_URL`), following one is refused, saying why. Followed
  wallets beyond what the stream takes aren't followed, and the health view
  says how many.
- **How a trade is seen,** per transaction and followed wallet, from the
  transaction's own balances before and after: its token balances, its SOL
  and its wrapped SOL.
  - **A buy:** a token came in, and SOL, a stablecoin (USDC, USDT) or another
    token went out.
  - **A sale:** a token went out, and one of those came back.
  - **Not a trade:** a token that only came in (an airdrop) or only went out
    (a transfer).
  - **Payment threshold:** the fee is added back when the wallet paid it, and
    SOL moves under 0.001 SOL don't count as a payment. What a buy paid
    includes a new token account's rent (about 0.002 SOL), so it says "about".
- **The rest is the EVM tracker's:**
  - the `wallet_trades` record (once per transaction, wallet, token and side);
  - the token check and, for a young token, the bundle check, on a buy alert;
  - the alert, with Solscan's link and the buy ready on the Trade desk;
  - at most 60 alerts a minute, the rest recorded and shown, not alerted.

**Falling behind:** a read that's more than two minutes behind starts again from
the newest block (the chain's pace is measured from its own blocks; Base makes
one about every 0.2 seconds now). A chain that can't be read keeps its place,
so the next read picks up what was missed.

## Endpoints

These log queries name no contract, so most free endpoints refuse them:
publicnode answers "Please specify an address", and Base's and BNB Chain's own
endpoints rate-limit them. They go to your own `RPC_URLS_<CHAIN>` first, then
the keyless endpoints that answered them on 13 November 2026
(`TOPIC_LOGS_RPC` in `src/providers/chains.js`): dRPC on all four chains,
1RPC (Base, BNB Chain), POKT/Nodies (Base, Ethereum), MEV Blocker (Ethereum),
Arbitrum's own, and blockrazor (BNB Chain, 10 wallets a query at most).

**For production, set `RPC_URLS_BSC` (and ideally the others) to your own
endpoint.** In a 50-second run against the real chains, the keyless BNB Chain
endpoints refused two reads in a row (dRPC rate limits, blockrazor's 10-wallet
cap); nothing was lost, but those alerts came 10 seconds late. A free QuickNode
or Alchemy plan covers it.

## Checked against the real chains (13 November 2026)

- The first 100 transaction senders in a few recent blocks on each chain,
  treated as followed wallets: plausible buys and sells on all four (for example
  a MARSBASE buy on Base for 0.0109 ETH, about $20.94; a GANG sale on BNB Chain
  for 1.17 BNB, the amount from the WBNB unwrap). The first version also called
  an Aave repayment a "sale"; the mint/burn and receipt rules above came from that.
- The worker's loop, run for a minute on 6 Base and 12 BNB Chain wallets that had
  just traded, against a real Postgres: about 30 trades recorded and alerted,
  each read taking 1–2 seconds, with the token check's result in each buy alert.

## Alerts

`monitor_alerts` rows of kind `wallet_trade`, one per follower (deduplicated by
chain, transaction, wallet, token and side), sent by `src/alerts/dispatch.js`.
Severity is medium (a signal, not a risk), or high when the token check found a
critical risk in what was bought. An account that switched the agent off isn't
alerted, and its wallets aren't read unless someone else follows them. At most
20 alerts go out per read; the rest are recorded and shown on the card.

## Data

`followed_wallets` is the user's own (in "Download my data", deleted with
"Delete my data"). `wallet_trades` are public onchain facts, stored without an
account and deleted after 35 days (`src/privacy/retention.js`); they're kept that
long so a followed wallet's recent trades can be shown and checked. (The top
wallets below come from the pump.fun stream instead: they're found among
everyone, not just wallets someone already follows.)

## Top wallets on pump.fun (built 24 November 2026)

Asked for by the owner on 24 November 2026: wallets worth following, found by
stated rules instead of brought by the user. `src/services/walletRankings.js`,
the "Top wallets on pump.fun" card on `/launches`, `GET /v1/wallet-tracker/top?window=7d|30d`.

**The source:** every buy and sell on pump.fun's bonding curves, from the
Yellowstone stream RektBull already reads for the launch feed
([LAUNCHES.md](LAUNCHES.md)). It needs no extra data plan, and it is empty until
the stream is switched on. Each trade event gives:
- the wallet and the coin;
- the SOL and tokens moved;
- pump.fun's fee and the creator's fee;
- the coin's creator.

**The rules** (shown with the ranking):
- **Realised profit only:** the SOL a wallet got back from selling a coin, less
  what that part cost at its average cost, after pump.fun's and the creator's
  fees. Coins still held don't count.
- **Only what RektBull saw:** trades on the curve while the stream ran. A coin
  bought before, or sold after it moved to PumpSwap, isn't counted. PumpSwap
  isn't on the stream: adding it would be one more filter, but much more data.
- **A coin counts as closed** once 99% of what was bought is sold: a win if
  the position made money. A position still open after 7 days is dropped.
- **Left out:**
  - a coin's creator trading it;
  - positions that started with a buy under 0.05 SOL;
  - buys within 2 seconds of a coin's creation (snipes, counted apart).
- **Ranked:** wallets with at least 5 coins closed in the window and a profit,
  by realised SOL. Each shows its return, coins and win rate, its best coin
  and its share of the total, and when it was last active.
- **Not ranked:** a wallet with over 500 trades in any day (a bot), or with
  more snipes than counted coins.

**Kept:**
- Per wallet and UTC day, the sums in `wallet_pnl_daily`, written once a minute
  by the worker that streams. These are public onchain facts, not tied to an
  account, deleted after 35 days.
- Open positions stay in that worker's memory: at most 400,000, the least
  recently traded dropped first. A restart starts them afresh, so sales of coins
  bought before it aren't counted.

**Follow** fills in the Wallet Tracker's form for the wallet, so the user gets
an alert within seconds of its next trade. Past profit says nothing sure about
the next trade: copying a wallet buys after it, at a worse price, and some
wallets trade to be copied. The card says so.


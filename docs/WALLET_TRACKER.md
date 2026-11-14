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
pools); Solana (addresses are recognised and the table stores them, so adding
it needs no schema change; following one says it comes with Solana trading).

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
long for the next part of stage 3, wallets ranked by realised profit.

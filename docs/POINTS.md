# RektBull Points (/points)

A rebate of the trading fees a user pays RektBull, given back as points they
can spend on subscriptions. These are separate from the monthly **free points**
for safety checks (`src/payments/points.js`), which are a different allowance.

| | Default | Where it's set |
| --- | --- | --- |
| Rebate | 25% of each trading fee | Admin panel, "RektBull Points" |
| A point is worth | $0.10 of subscriptions | Admin panel |
| Most ever issued | 1,000,000,000 points | Fixed in the code (`CAP`) |
| Token wording on the page | "RektBull Points will be convertible 1:1 for a RektBull utility token at its token generation event (TGE)." | Admin panel |

So a $10 fee earns 25 points ($2.50 of subscriptions).

## What earns points

Every trading fee RektBull earns, credited only once the fee is known to
have been earned, and once per fee (one row per source and reference):

| Fee | Credited when | From |
| --- | --- | --- |
| Swap you signed (EVM, Solana) | The trade is confirmed onchain | The fee the trade's plan showed (`trade/positions.js`) |
| Automatic swap (Trade Router) | The router's `Swapped` event is confirmed | The router's fee, as a share of the trade's value (`trade/autonomous.js`) |
| Order fill on BNB Chain or Base (stop-loss, take-profit, Meme Watch exit, limit buy) | The Meme Router's `Filled` event is confirmed | The fee in that event, priced in USD then (DefiLlama: ETH, BNB or VIRTUAL) (`trade/memeOrders.js`) |
| Order fill on Solana | The order program's `Filled` event is confirmed | The fee in that event, priced in USD then (DefiLlama: SOL) (`trade/solanaOrders.js`) |
| Hyperliquid perps fee, page orders | Hyperliquid's answer reports a fill | Builder rate times what filled (`routes/hyperliquid.js`) |
| Hyperliquid perps fee, automatic | The automatic order fills | The same (`hyperliquid/auto.js`) |
| Polymarket trading fee | Polymarket's builder-trades feed shows the fill confirmed | Builder rate times the fill's USDC size, matched to the user by the order RektBull prepared (`polymarket/fills.js`, every 10 minutes) |
| Polymarket profit share | The redemption that paid it is confirmed | The share in the batch (`polymarket/wallets.js`) |

A rebate that can't be written (or, for an order fill, priced) is logged and never stops the trade it's for.

## The cap

At most 1,000,000,000 RektBull Points are ever issued. Issuing is serialised
(a Postgres advisory lock), so the cap is never passed. The last rebate is cut
to what's left and says so. After that, rebates stop; points already earned
stay. The page and the admin panel show how many remain.

## Spending

Points buy any subscription (prepaid pass) at the point's value, rounded up:
Safety Pro for 30 days at $9 costs 90 points. The purchase and the points
spent are one database transaction, and the balance can't go below zero.

## The token wording: the owner's decision, and a caution

The owner chose to say that points will convert 1:1 to a utility token at TGE.
The wording is an admin setting, so it can change without a code change.

- **The legal question.** Promising tokens in return for fees paid is what
  regulators look at to decide whether points are a token presale (a security),
  whatever the token is called. Get legal advice before launch, especially
  where the swap desk isn't region-blocked.
- **What the cap does.** It bounds a 1:1 conversion at 1,000,000,000 tokens.

## API

- `GET /v1/points` (signed in): balance, value, history, supply, the
  subscriptions and their prices in points.
- `GET /v1/points/info` (public): the rate, the cap, the wording and the prices.
- `POST /v1/points/passes/:product`: buy a subscription with points (402 if
  there aren't enough).
- Admin: `GET/PUT /v1/admin/rewards`, with a reason, logged. It sets the value,
  the rebate and the wording, never a balance.

## Tests

`test/rewardPoints.test.js` covers the rebate maths, once per fee, the cap, buying with points, a
confirmed swap, order fills on both chains (`memeOrders.test.js`, `solanaOrders.test.js`: once each, and none when the price can't be read), the Polymarket fills feed (confirmed fills only, RektBull's
code only, never twice), and the API.

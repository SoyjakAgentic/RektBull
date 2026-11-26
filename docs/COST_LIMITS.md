# Limits set to keep data costs down

RektBull hasn't launched yet. Some features are deliberately narrowed so the
data plans stay small. This is the register of those choices, kept so each one
can be lifted once there's volume to justify the cost.

**When to lift one (the owner's direction, 25 November 2026):** when RektBull's
own trading-fee revenue grows. Order fills, swaps, perps and Polymarket fees
are recorded per user in `reward_points.fee_usd` and on the admin dashboard.

**What stream volume does and doesn't tell you:** a busy stream is not, by
itself, a sign of revenue. The streams below count everyone's trades on
pump.fun, four.meme and the pools RektBull watches, not only RektBull's users'.
A day the market is busy costs more data whether or not RektBull earned more
that day.

Every limit below is an admin setting or a constant named here. Raising one is
a settings change, not a rebuild, unless noted.

## The plans they protect

- **Chainstack Growth:** $49 a month for 20 million request units and 250
  requests a second (BNB Chain and Base RPC and WebSockets). Sized on
  25 November 2026 (docs/MEME_ROUTER.md). Every pushed WebSocket log counts as
  a request.
- **Chainstack Yellowstone gRPC (Solana):** one subscription, at most 20
  filters (`providers/yellowstone.js`, `MAX_FILTERS`).

## BNB Chain and Base (the WebSocket stream, `trade/memeStream.js`, admin panel: Controls, "Order triggers over WebSocket")

| Limit | Default | What it costs users | To lift |
|---|---|---|---|
| `daily_budget`: pushed logs a day, both chains | 150,000 (about 4.5 million a month) | At it, price and curve subscriptions stop until the next UTC day: orders fire on the trade pass's polling, up to about 25 seconds late instead of within a block | Raise in the admin panel; check the month's total against the plan |
| `max_pools`: pools streamed per chain | 10, the orders nearest their trigger first | Other orders fire on polling | Raise in the admin panel |
| `arm_pct`: how near its trigger an order must be to be streamed | 15% | Orders further away fire on polling until they come near | Raise in the admin panel |
| `max_insider_coins`: Meme Watch coins streamed per chain | 50, coins with an exit first | The rest get Meme Watch's 6-hour check instead of alerts within seconds | Raise in the admin panel |
| `rankings_daily_budget`: four.meme events a day for the wallet rankings (BNB Chain), counted apart from `daily_budget` | 50,000 (four.meme sent about 10,000 a day of trades and creations when measured, 25 November 2026) | At it, the ranking stops counting until the next UTC day: partial on a busy day, and the page says so | Raise in the admin panel; 0 switches it off |

## Not built yet, to keep scope and cost down

- **Wallet rankings on Base.** Virtuals' curve trades are emitted by a
  separate pair contract for each coin, and their event layout isn't in
  Virtuals' verified ABIs (BondingV5, FRouterV3: no trade events) or another
  source checked on 25 November 2026. Adding it means reading Virtuals' pair
  contracts, then one more filter on Base's stream with its own budget.
- **four.meme coins after they graduate.** Sales on PancakeSwap aren't
  streamed, so a position still open when its coin graduates is dropped after
  7 days, never counted. Solana does this for PumpSwap
  (`max_amm_pools`, below). On BNB Chain it would mean following each
  graduated coin's PancakeSwap pool: more events, under the same budget.
- **four.meme coins priced in anything but BNB** (USD1 and the like) aren't
  ranked.

## Solana (the Yellowstone stream, `services/pumpStream.js`)

| Limit | Default | What it costs users | To lift |
|---|---|---|---|
| Filters on the one subscription | 20 (Chainstack's limit): pump.fun's program, PumpSwap's pools, the Wallet Tracker's wallets, Meme Watch's insiders | Beyond them, insider wallets fall back to the 6-hour check; followed wallets beyond the stream's room aren't followed (the health view counts both) | A second subscription, on the provider's terms |
| Meme Watch insider wallets | 200 a filter, at most 19 filters: 3,800 wallets | As above | As above |
| `max_amm_pools`: PumpSwap pools followed for the wallet rankings | 200, the most recently graduated first | A position on a coin over the cap is dropped (the Health tab counts them) | `RULES.max_amm_pools` in `services/walletRankings.js` (a code change) |

## Hyperliquid copy trading (`hyperliquid/copy.js`)

Hyperliquid's info API is free, limited to 1,200 request weight a minute per
IP (RektBull keeps `HL_WEIGHT_PER_MINUTE`, 1,000, for itself). Its WebSocket
allows only 10 users per IP, so followed traders are read over REST.

| Limit | Default | What it costs users | To lift |
|---|---|---|---|
| Traders watched in all | 30 (`HL_COPY_MAX_LEADERS`): 30 × 4 reads a minute × weight 2 = 240 weight a minute | A new trader can't be followed once 30 are watched; traders others already copy still can | Raise it, or read from a second IP |
| How often a trader is read | Every 15 seconds (`HL_COPY_POLL_MS`) | Copies are placed about 15 to 30 seconds after the trader's trade | Lower it: the weight grows with it |
| Traders per account | 3 (`MAX_FOLLOWS` in `copy.js`, a code change) | | |

## Other costs held down

- **Wallet rankings' open positions** are kept in the streaming process's
  memory: at most 400,000 a chain, the least recent dropped first. A restart
  starts them afresh. (`MAX_POSITIONS`)
- **Jito tips** on Solana order fills: at most 0.0002 SOL a fill
  (`SOLANA_JITO_TIP_MAX_LAMPORTS`), paid by RektBull. docs/PRIVATE_SEND.md
- **Private submission relays** on BNB Chain: free ones only (48 Club,
  BlockRazor full privacy). docs/PRIVATE_SEND.md
- **The trade pass** polls every 15 seconds (`TRADE_TICK_MS`), with
  DexScreener's prices kept 10 seconds. Order triggers outside the stream fire
  up to about 25 seconds late.

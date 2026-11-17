# Prediction markets on Polymarket (/predictions)

Users browse Polymarket's markets and trade them from **their own Polymarket
wallet**. The user's wallet signs every order and every set-up step.

- **Orders** go from the user's browser straight to Polymarket's order book.
- **API credentials.** Polymarket's credentials are derived in the browser from
  a wallet signature and kept in that tab only (sessionStorage).
- **What the server does and doesn't do.** RektBull's server prepares orders
  and set-up for signing. It never signs, never holds funds or keys, and never
  sees the credentials or an order's signature.

Trading is off until `POLYMARKET_ENABLED` and a builder code are set. Browsing
works either way.

Sources: Polymarket's docs (docs.polymarket.com, read 16 and 17 November
2026):

| Topic | Doc pages |
| --- | --- |
| pUSD and contracts | concepts/pusd, resources/contracts |
| Wallets and authentication | trading/wallets-auth, getting-started/api |
| Orders | trading/place-orders, api-reference/trade/post-a-new-order and cancel-single-order |
| Builder fees | programs/builders/fees, api-reference/trade/get-builder-trades |
| Fees | trading/fees |
| Session keys | trading/session-keys |
| Geoblocking | api-reference/geoblock |

## What a user does

1. **Sign in** with the wallet that owns the Polymarket wallet.
2. **Create the Polymarket wallet** (a Deposit Wallet). This is Polymarket's
   default smart wallet since 4 May 2026. It belongs to the user's key, and
   Polymarket's relayer pays its gas. RektBull asks the relayer with its own
   Builder API key; that is RektBull's secret, never a user's.
3. **Approve Polymarket's exchange.** There are eight trading approvals,
   pUSD and outcome shares, to Polymarket's exchange contracts. The page
   explains each one. They're trading approvals, not billing, and give
   RektBull nothing. The wallet signs one batch, and Polymarket's relayer
   sends it.
4. **Add money.** The user wraps their own Polygon USDC.e into pUSD (Polymarket's
   collateral), credited to their Polymarket wallet. That's two transactions
   from their own wallet: an approval of exactly the amount, then the wrap.
5. **Trade:**
   - Pick an outcome and an order type: market (fill what you can, or all or
     nothing) or limit.
   - RektBull prepares the order from the live book. It checks the tick size,
     the minimum order and how far a market order would move the price, and
     shows the fees.
   - The wallet signs the order (EIP-712, wrapped for the Deposit Wallet as
     ERC-7739).
   - The browser asks Polymarket's geoblock check first. It then sends the order
     to `clob.polymarket.com/order` with L2 headers: an HMAC of timestamp,
     method, path and body, made with the user's own API secret.
6. **Positions and PnL** are Polymarket's own figures, from its Data API.
   **Redeeming winnings** is one batch the wallet signs.

Legacy Proxy and Safe wallets can have orders prepared. Their set-up and
redemptions stay on polymarket.com, because Polymarket documents no way for
another app to send them.

## RektBull's fee

This is a Polymarket **builder fee**. RektBull's builder code
(`POLYMARKET_BUILDER_CODE`) is signed into every order.

- **When it's charged.** Polymarket charges the fee only when an order fills,
  and pays it daily to RektBull's builder profile. An order that doesn't fill,
  or is cancelled, costs nothing.
- **The rate.** It's set on the builder profile, not in the order: 0.01% by
  default, taker and maker (`POLYMARKET_BUILDER_TAKER_FEE_BPS`,
  `POLYMARKET_BUILDER_MAKER_FEE_BPS`). These settings must match the profile;
  they're what the page shows. Polymarket's caps are 1% taker and 0.5% maker.
- **On top of Polymarket's own fee.** It's added to Polymarket's taker fee on
  the markets that have one. Geopolitics markets are fee-free on Polymarket's
  side.
- **Records.** Fills carrying the builder code are listed publicly at
  `clob.polymarket.com/builder/trades?builder_code=…`.

## Region blocks

Polymarket blocks, or allows only closing positions from, many countries
itself. These include the US, the UK, France, Germany, Italy, Poland,
Australia, Singapore and Taiwan (api-reference/geoblock), checked on the IP
that sends the order. Here that's the user's own browser. The page asks
Polymarket's geoblock check before it offers to send.

RektBull's own region blocks are set per venue in the admin panel and start
empty ([ADMIN.md](ADMIN.md#region-blocks)).

- **What they stop:** buying, wallet set-up and approvals.
- **What they never stop:** selling, redeeming, withdrawing, or sending what
  was already prepared.

## Automatic trading: not built, waiting on a decision

Polymarket has **Session Keys** (trading/session-keys).

- **What they allow.** A user's Deposit Wallet can authorize another key to
  place orders. It can never withdraw. Revoking it cancels its open orders.
- **What they don't allow.** The term is fixed at 180 days, and Polymarket
  documents no onchain per-order or per-day limits. Like Hyperliquid's agents,
  the user's limits would be enforced by RektBull, not onchain.
- **The difference from Hyperliquid.** The orders would be sent from
  RektBull's servers. Polymarket checks the sending IP, so orders from
  RektBull's servers could get around Polymarket's own block for users in
  blocked or close-only countries. Polymarket also says third-party apps that
  trade for users aren't eligible for its co-location programme.

Before building it, the owner decides whether to offer it, and if so, how to
stop it from getting around Polymarket's own geoblock. For example, it could
be refused for users whose country Polymarket blocks. Fable's groundwork for
the Session Key batches is in `src/polymarket/wallets.js` (`session_authorize`,
`session_revoke`), unreachable from any route.

## What to check on the first real trade

- **`POLY_ADDRESS` on L2 requests is the owner's own address.** The docs'
  examples imply this; they don't state it for Deposit Wallets.
- **`owner` in the order body is the API key.** The docs' examples show this.

## Settings

| Setting | |
| --- | --- |
| `POLYMARKET_ENABLED` | Trading on `/predictions` |
| `POLYMARKET_BUILDER_CODE` | RektBull's public builder code (bytes32), from polymarket.com > Settings > Builders |
| `POLYMARKET_BUILDER_TAKER_FEE_BPS`, `POLYMARKET_BUILDER_MAKER_FEE_BPS` | The profile's rates, shown to users (1 = 0.01%) |
| `POLYMARKET_BUILDER_API_KEY`, `…_SECRET`, `…_PASSPHRASE` | RektBull's Builder API key for the relayer (Secret Manager) |

## Tests

- `test/polymarket.test.js`: market data, order building and signing against
  Polymarket's documented formats, wallet set-up and orders end to end, and
  region blocks.
- `test/browser/predictions.js`: the page in Chromium. It covers credentials
  from a ClobAuth signature, an order signed by the wallet and sent from the
  browser with correct L2 headers, and checks the server never stored the
  credentials.

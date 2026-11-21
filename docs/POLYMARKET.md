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

### Profit share on redemptions

Winnings redeemed through the page carry **10% of the profit**: the payout
minus what the shares cost, from Polymarket's Data API. It's a pUSD transfer
to `POLYMARKET_FEE_WALLET` in the same batch as the redemption, so it's paid
only if the redemption goes through. Nothing is taken on a loss. The rate is
the `polymarket_profit` price in the admin panel (at most 10%). Redeeming on
polymarket.com, or selling before the market resolves, skips it.

## Region blocks

Polymarket blocks, or allows only closing positions from, many countries
itself. These include the US, the UK, France, Germany, Italy, Poland,
Australia, Singapore and Taiwan (api-reference/geoblock), checked on the IP
that sends the order. Here that's the user's own browser. The page asks
Polymarket's geoblock check before it offers to send.

RektBull's region blocks for Polymarket **start with that same list**:
blocked and close-only alike, plus the places Polymarket's own site limits.
They're set per venue in the admin panel ([ADMIN.md](ADMIN.md#region-blocks)).

- **What they stop:** buying, wallet set-up and approvals.
- **What they never stop:** selling, redeeming, withdrawing, or sending what
  was already prepared.

## Automatic trading (Session Keys)

The owner approved this on 21 November 2026, as a second exception next to
Hyperliquid (CLAUDE.md), with every limit disclosed before the user signs.
Code: `src/polymarket/auto.js`, routes `/v1/polymarket/auto`, the page's
"Automatic AI trading" card. It starts **off** twice over: `POLYMARKET_AUTO_ENABLED`
on the server, and "Place automated Polymarket entries" in the admin panel.

**The permission** (docs.polymarket.com/trading/session-keys):

- The user's own key signs one Deposit Wallet batch,
  `authorizeSessionSigner(RektBull's key, validUntil)`, sent through
  Polymarket's relayer (`POST /v1/session-signers/authorizations`, scope `CLOB`).
- **Duration:** Polymarket fixes the term at **180 days**; it can't be
  shorter. RektBull stops at the user's own earlier date (1 to 179 days), and
  the user can end the key at any time.
- **What Polymarket enforces:** the key can place orders for the wallet; it
  can't withdraw. Revoking it (`revokeSessionSigner`, signed by the user's own
  key) cancels the orders it placed.
- **What Polymarket doesn't enforce:** per-order and 24-hour limits, the stop
  date and the markets. **RektBull's servers keep them, not onchain.** The page
  says so, and that the most a user can lose is what's in their Polymarket
  wallet.
- **RektBull's key:** `KMS_POLYMARKET_SESSION_KEY_VERSION` (Cloud KMS),
  public address `POLYMARKET_SESSION_ADDRESS`. It derives its own CLOB API
  credentials (L1 ClobAuth), held in memory only. No user key or user
  credential reaches the server.

**What it places**, from the AI's researched forecasts (docs/AI_PROPOSALS.md):

- **Only buys.** It never sells; positions are held to resolution or sold by
  the user on the page.
- **When:** medium or high confidence, and the AI's probability beats the price
  by `auto_edge_pct` points (10 by default, stricter than proposals' 8).
- **How:** a fill-and-kill order at no worse than the forecast's price limit
  (the AI's probability minus the edge) and within 3% of the best ask. If the
  price has moved past the limit, nothing is sent.
- **Size:** the user's per-order limit, cut to what's left of their 24-hour
  limit; never under `auto_min_order_usd` ($25). One entry per forecast per user.
- **Before each order:** the key is active, before the user's stop date and an
  hour inside Polymarket's term, the user has AI credits for the fee, and the
  user's last-seen country isn't on Polymarket's region list.

**Region blocks.** These orders are sent from RektBull's servers, so
Polymarket's own IP check sees RektBull, not the user. RektBull therefore
checks the user's country (from `GEO_COUNTRY_HEADER` and
`GEO_SUBDIVISION_HEADER`) when they turn it on, records it each time they
open the page, and places nothing while that country is on the Polymarket list,
or unknown while the list is set. Stopping is never blocked.

**The fee:** `auto_fee_pct` (1%) of what fills, at least `auto_fee_min_usd`
($0.25), from Safety Pro AI credits (the 30-day allowance, then a top-up),
charged only when an entry fills. Nothing is charged for an order that doesn't
fill. The builder fee and the profit share on redemptions apply as usual.

**Turning it off** marks the key revoked at once, so RektBull places nothing
more, then gives the user the revocation to sign so Polymarket ends the key too.
The worker ends keys past their stop date every 15 minutes (`polymarket_auto`).

**To check on the first real trade:**

- The relayer accepts the authorization as documented (`validUntil` exactly
  now + 4,315 hours, per the docs' example).
- An order signed by RektBull's key with the Deposit Wallet as maker and signer,
  wrapped (ERC-7739) and in the session envelope, is accepted.
- `makingAmount` in the answer to a matched FAK buy is the pUSD paid.

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
| `POLYMARKET_FEE_WALLET` | Public address for the profit share on redemptions (unset: none) |
| `POLYMARKET_BUILDER_API_KEY`, `…_SECRET`, `…_PASSPHRASE` | RektBull's Builder API key for the relayer (Secret Manager) |
| `POLYMARKET_AUTO_ENABLED` | Automatic trading through Session Keys (also switched on in the admin panel) |
| `POLYMARKET_SESSION_ADDRESS`, `KMS_POLYMARKET_SESSION_KEY_VERSION` | RektBull's Session Key: its public address, and its KMS key |

## Tests

- `test/polymarket.test.js`: market data, order building and signing against
  Polymarket's documented formats, wallet set-up and orders end to end, and
  region blocks.
- `test/browser/predictions.js`: the page in Chromium. It covers credentials
  from a ClobAuth signature, an order signed by the wallet and sent from the
  browser with correct L2 headers, and checks the server never stored the
  credentials.

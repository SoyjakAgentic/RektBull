# Perps on Hyperliquid (/perps)

Users trade Hyperliquid perpetuals from **their own Hyperliquid account**. The
money stays in that account, and the user's wallet keys stay in their wallet.
RektBull never receives a key and never relays a deposit, transfer or
withdrawal: those are made on Hyperliquid itself.

Everything is off until switched on: `HL_ENABLED` for the page's trading,
`HL_AUTO_ENABLED` for automatic trading. Viewing markets works either way.

Sources: Hyperliquid's API docs (hyperliquid.gitbook.io/hyperliquid-docs,
read 16 November 2026): exchange endpoint, info endpoint, signing, nonces and
API wallets, builder codes, rate limits. The signing code (`public/hl-core.js`)
is checked against the vectors in Hyperliquid's own Python SDK, by recovering
the signer, so no private key is in the repo. It was also checked against the
public testnet.

## The two kinds of signature

Hyperliquid's trading actions ("L1 actions": orders, cancels, leverage) are
signed for Hyperliquid's own chain id, 1337, which wallets such as MetaMask
refuse to sign. So, as in Hyperliquid's own app:

1. **The user's wallet signs approvals:**
   - `approveAgent` approves a trading key;
   - `approveBuilderFee` approves RektBull's fee.

   These are EIP-712 messages for the wallet's current chain.
2. **An approved agent key signs orders.** Hyperliquid lets an agent place and
   cancel orders and change leverage for the account. It **never** lets one
   withdraw or transfer.

## Manual trading

The Perps page makes a trading key in the browser and keeps it there
(localStorage). The user's wallet approves it for 30 days. The key signs
orders in the browser, and only the signature is sent. "End this trading key"
replaces it with an address whose key the browser throws away at once.

The relay (`src/hyperliquid/relay.js`) passes signed actions on, so the rules
hold on the server:

- **What it carries:**
  - orders: market as IOC with a slippage cap, limit, and reduce-only
    take-profit and stop-loss;
  - cancels;
  - leverage and isolated-margin changes;
  - the two approvals, and only when the signed-in wallet signed them.
- **What it refuses, whatever is signed:** every transfer, withdrawal,
  vault, subaccount, TWAP or referrer action, and actions for a vault or
  subaccount.
- **Trigger orders** (take-profit and stop-loss) must be reduce-only.

## Automatic trading

RektBull's AI agents can open and close positions for a user, within limits
the user sets.

| | Enforced by |
| --- | --- |
| The agent can trade, and can never withdraw or transfer | **Hyperliquid** |
| The approval ends at the expiry the user signed (at most 30 days), or when replaced | **Hyperliquid** |
| Per-trade amount, amount opened per 24 hours, leverage cap, allowed markets | **RektBull's trade service, not onchain** |
| Deep markets only (open interest and 24-hour volume at least $5M each by default) | RektBull |
| Immediate-or-cancel, within 0.5% of the mark price (`HL_AUTO_PRICE_BAND_BPS`); refused when mark and oracle disagree by more | RektBull |
| Isolated margin, at most `HL_AUTO_MAX_LEVERAGE` (10x by default) and the user's cap | RektBull |
| Stops and take-profits are reduce-only | RektBull |

**The most a user can lose is the margin in their Hyperliquid account.** The
page says this, and that the limits are RektBull's, not onchain. This is the
one exception to CLAUDE.md's rule that session-key limits are enforced
onchain. The owner approved it, because Hyperliquid has no onchain spend
limits for agents.

- **The key.** RektBull's agent key ("rektbull-auto") lives in Google Cloud
  KMS (`KMS_HL_AGENT_KEY_VERSION`, secp256k1). Only the trade service's
  account can use it. Users approve its public address, `HL_AGENT_ADDRESS`.
  Every signature is logged first (`key_signatures`), so KMS's audit log can be
  matched to orders. `DEV_HL_AGENT_KEY`, a throwaway key, is accepted only on
  the testnet and never in production.
- **Granting** (`POST /v1/hyperliquid/auto/grant`). The user's wallet signs
  `approveAgent` for RektBull's agent under the name "rektbull-auto" with an
  expiry. RektBull checks the signature is the signed-in wallet's, sends it to
  Hyperliquid, and records the limits (`hl_auto_grants`). The plain relay
  refuses to approve RektBull's agent, so a grant always has its limits.
- **Orders** (`POST /v1/hyperliquid/auto/intents`) are queued and sent by the
  trade service (`src/hyperliquid/auto.js`). Just before signing, every check
  runs again against the market as it is then. Each signed action also passes
  `relay.check`, so automatic orders follow the same rules as the page. An
  order that waited over 2 minutes is refused rather than sent at a price
  nobody saw.
- **Stopping.** "Stop automatic trading" ends the grant at once, cancels
  queued orders, and has the wallet sign a replacement agent under the same
  name, so Hyperliquid drops RektBull's agent too. The admin panel's
  "Automatic trading" emergency stop cancels every queued order and refuses
  new ones. Open positions stay open in every case: the user closes them on
  the page.

**What a stolen KMS key could still do.** It could trade a user's account
badly within Hyperliquid's rules: it could not withdraw or transfer. That's why
the key stays in KMS behind the trade service's account, and why the most a
user can lose is what they keep in that Hyperliquid account.

## Protecting positions (proposals, phase 1)

Decided by the owner on 23 November 2026. RektBull checks the positions a user
already holds against stated rules, and says what's happening in the deep
markets. It never predicts a price or proposes opening a position. Entry
proposals, if ever, come later, after a shadow period with a public scorecard.
The code is `src/hyperliquid/protect.js`.

**Proposals for a position** (`GET /v1/hyperliquid/protect`, the "Protect your
positions" card):

| Rule | Proposed |
| --- | --- |
| The liquidation price is within 5%, or within a typical day's range (the last 24 hourly candles, high to low), whichever is wider. Critical within half of that. | Reduce by half: a reduce-only IOC at no worse than 1% from the mark |
| No stop-loss on the book that would close the position before its liquidation price | A stop-loss for the whole position (reduce-only, at the market when it triggers), 3 typical hourly moves from the mark and never more than 60% of the way to the liquidation price. With no candles: 5%. |
| Funding against the position at 25% a year or more | Facts only: what it costs a day, and since it opened |

- **Every fix is reduce-only.** It can close, never open or add, so region
  blocks and a paused Perps service never stop it.
- **The user signs.** The trading key in the browser signs the proposal's
  orders, as for any order on the page.
- **A proposal is good for 10 minutes and is used once.** Then it's made again
  from the prices then (`hl_proposals`).
- **No AI.** Each proposal's words are written from its facts, and every fact
  names its source. If the candles or open orders can't be read, the proposal
  says so. With open orders unread, it doesn't propose a second stop-loss.

**The proposal fee.** An order from a proposal carries RektBull's proposal fee,
`HL_PROPOSAL_FEE_TENTHS_BPS` (50 = 0.05%), instead of the 0.01% on the user's
own orders. Hyperliquid sets the builder fee per order, so this needs no
second builder address.
- **The approval:** the user's wallet approves the higher rate once, as a
  most-per-fill rate. The relay relays a fee approval up to the higher of the
  two rates and no more.
- **Where it may be carried:** the relay accepts 0.05% only on a request that
  names a live proposal of the signed-in account (`proposal_id`), and only when
  every order in it is reduce-only, in that proposal's market. Anything else
  at 0.05% is refused (`wrong_fee`).
- **Opting out:** the page says the user can place the same order themselves
  in the order form, at 0.01%.

**Market alerts** (`GET /v1/hyperliquid/alerts`, open to everyone, the "Market
alerts" card) cover the deep markets only (open interest and 24-hour volume of
$5M or more each):
- funding of 100% a year or more, either way (high at 200%);
- the mark price 0.5% or more from the oracle price;
- open interest up 10% or more in an hour while the price moved under 1%;
- open interest down 10% or more in an hour.

Open interest is compared with RektBull's own snapshots, taken every 5 minutes
by the `hl_markets` job (`hl_market_snapshots`, kept 48 hours). The alerts are
facts, not a call on direction.

**Perps Guard** (the AI agents page, free, every 5 minutes, off until the user
switches it on) runs the same review and alerts each risk once per position.
It alerts again if the risk gets worse (high to critical). Each alert links the
fix on the Perps page. It never trades.

## The fee

This is a Hyperliquid builder code: 0.01% of each fill by default, which is
what Axiom charges. Orders from a RektBull proposal carry 0.05% instead (see
above). It's taken by Hyperliquid on fills only, after the user approves it
once. See [PAYMENTS.md](PAYMENTS.md#perps-fees-hyperliquid-builder-code).

## Region blocks

These are set per venue in the admin panel ([ADMIN.md](ADMIN.md#region-blocks)).
They start with Hyperliquid's own list: the United States and Ontario (its
Terms of Use), plus the places under comprehensive US sanctions.

- **What they stop:** opening positions, leverage changes and new approvals,
  for manual and automatic trading alike.
- **What they never stop:** viewing, cancelling, closing, revoking.

`GEO_COUNTRY_HEADER` must be set before trading is switched on. Without it,
the blocks refuse everyone.

## Settings

| Setting | |
| --- | --- |
| `HL_ENABLED` | Trading on the page (viewing works either way) |
| `HL_NETWORK` | `mainnet` or `testnet` |
| `HL_BUILDER_ADDRESS`, `HL_BUILDER_FEE_TENTHS_BPS` | The fee (PAYMENTS.md) |
| `HL_PROPOSAL_FEE_TENTHS_BPS` | The fee on an order from a RektBull proposal (50 = 0.05%) |
| `HL_AUTO_ENABLED` | Automatic trading |
| `HL_AGENT_ADDRESS`, `KMS_HL_AGENT_KEY_VERSION` | RektBull's agent: public address, and its KMS key (trade service only) |
| `HL_AUTO_MAX_LEVERAGE`, `HL_AUTO_PRICE_BAND_BPS` | Leverage cap (10), price band (50 = 0.5%) |
| `HL_AUTO_MIN_OPEN_INTEREST_USD`, `HL_AUTO_MIN_DAY_VOLUME_USD` | How deep a market must be for automatic opens ($5M each) |
| `HL_WEIGHT_PER_MINUTE` | RektBull's share of Hyperliquid's 1,200 request weight a minute per IP |
| `GEO_COUNTRY_HEADER`, `GEO_SUBDIVISION_HEADER` | The load balancer's country and region headers, for region blocks |

## Before switching automatic trading on

1. Create the KMS key (HSM, `EC_SIGN_SECP256K1_SHA256`) and grant
   `roles/cloudkms.signer` to the trade service's account only. Set
   `KMS_HL_AGENT_KEY_VERSION` on the trade service, and the key's address as
   `HL_AGENT_ADDRESS` on every service.
2. Try it end to end on Hyperliquid's testnet first (`HL_NETWORK=testnet`).
3. Fund the builder address with at least 100 USDC on Hyperliquid, so it can
   collect fees.

## Tests

- `test/hyperliquid.test.js`: signing, against Hyperliquid's SDK vectors, plus
  tick and lot rules.
- `test/hyperliquidApi.test.js`: the relay's rules, the fee and region blocks
  through the app.
- `test/hyperliquidAuto.test.js`: grants, limits, the price band, the fee
  check, isolated margin, closing, region blocks, the emergency stop and
  revoking.
- `test/hlProtect.test.js`: the protection rules, the proposal fee only on a
  live proposal's reduce-only orders, the market alerts and Perps Guard.
- `test/browser/perps.js`: the page in Chromium, manual and automatic.

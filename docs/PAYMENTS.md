# Payments

Crypto only. Every paid run goes through the same payment gate
(`src/payments/gate.js`), which charges only for runs that succeed.

| Rail | For | Account needed | Code |
|---|---|---|---|
| **x402** | Runs up to about $1, bots, other agents | No | `payments/x402.js`, `payments/facilitator.js` |
| **Credits** | Everything; the main rail on the website | Yes (wallet sign-in) | `payments/credits.js`, `invoices.js`, `watcher.js` |
| **NOWPayments** | Credits or a pass, paid in any coin NOWPayments takes, on its own page; forwarded to RektBull's payout wallet. A fee per payment | Yes | `payments/nowpayments.js` |
| **Free points** | 30 a month per signed-in wallet (10 for a wallet with no transactions yet) | Yes | `payments/points.js` |
| **Safety Pro** (a pass) | Every Safety desk check for a fixed time | Yes | `payments/passes.js` |
| **Yield move fee** | Each yield move RektBull prepares: 0.1% of the amount moved, in the moved asset (exits to the wallet are free) | No (proposals need Safety Pro) | `yield/proposals.js` |
| **Claim fee** | Airdrops and rewards claimed through RektBull: 5% of what arrives (3% with Safety Pro), in the claimed tokens | No | `services/claims.js` |

## Order a run is paid in

For a signed-in wallet: an active **Safety Pro** pass that covers the
product, then the month's **free points**, then **credits**. An `X-PAYMENT`
header (x402) is used first whenever it's sent. If nothing applies, the
answer is `402 Payment Required` with every option, including x402 terms in
`accepts`, how many points it costs, and Safety Pro.

If the run fails, the pass use, the points or the credits are given back and
an x402 payment is never settled. Input is validated before anything is
charged.

| Run | Points | Price | Safety Pro |
|---|---|---|---|
| Token quick check | 1 | $0.25 | Included (fair use 200 a day) |
| Approval cleanup | 5 | $1 | Included (fair use 20 a day) |
| Proposal summary (AI, governance) | 1 | $0.10 | Included (fair use 50 a day) |
| Token report (AI) | — (each costs real AI money) | $3 | 5 a month included, then $3 |

**Free points** (`FREE_POINTS` in `payments/catalog.js`): 30 a month (UTC),
fixed when the month's first point is spent. A wallet with no transactions
and no code on the chains in `NEW_WALLET_CHECK_CHAINS` (default Ethereum and
Base) gets 10, so new wallets can't be farmed; if that check can't run, the
wallet gets 30. At most 20 point-paid runs a day come from one IP address.
Approval previews (counts and value at risk, no names) are free and don't
use points: 3 a day signed out, 10 signed in.

## x402

1. Unpaid request → `402` with `accepts: [{ scheme: "exact", network: "base",
   maxAmountRequired, payTo, asset: USDC, ... }]`.
2. The client signs a USDC transfer authorization (EIP-3009) and retries
   with it in `X-PAYMENT` (base64 JSON).
3. RektBull **verifies** with the Coinbase CDP facilitator, runs the work,
   then **settles**. The transaction comes back in `X-PAYMENT-RESPONSE`.

**The $1 question:** x402 client libraries default to refusing more than
about $1 a call unless the payer raises the limit. The $0.25 quick check
works with default clients. The $3 report accepts x402 too, but most
callers will need to raise their limit or use credits; the catalog says so
in `x402_note`.

**Setup:** `X402_PAY_TO` (an address you control, ideally a hardware wallet
or Safe), `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` from the Coinbase Developer
Platform.

> ⚠️ The facilitator client is ported from soyjak-agentic, where it was
> written against CDP's documented API but **never run end to end against
> the live service**. Test it with a real payment on Base Sepolia (set
> `X402_NETWORK=base-sepolia` and `X402_ASSET_ADDRESS` to Sepolia USDC) before enabling it
> in production.

## Credits and top-ups

- Each account gets **one deposit address**, the same on every EVM chain:
  child *n* of `CRYPTO_DEPOSIT_XPUB` (`m/44'/60'/0'/0/n`). The server only
  ever has the public key.
- `POST /v1/invoices { chain, token, amount_cents }` (or `{ chain, token,
  product: "pro_30d" }`) returns the address, the token contract and the
  exact amount to send.
- The **watcher** (worker role) scans USDT/USDC `Transfer` logs to watched
  deposit addresses, waits for confirmations (Ethereum 12, BNB Chain 15,
  Base 12), re-reads the receipt to rule out reorgs, then credits the
  amount at $1 per token, rounded down to the cent.
- **Every confirmed deposit is credited**, whether or not it matches an
  invoice: a late, short or extra payment is never lost. Deposits are
  counted toward the oldest open invoice; when one is covered, it's marked
  paid and its product (a pass) is bought from the credits.
- Ledger entries are append-only and each has a unique ref, so a deposit,
  run or refund can't be written twice.

Accepted: USDT and USDC on Ethereum and BNB Chain; USDC on Base. Minimum
top-up `MIN_TOP_UP_CENTS` (default $5).

### Making the deposit keys (offline, once)

On an offline machine, generate a 24-word mnemonic in a wallet or with
soyjak-agentic's `npm run deposit:keys -- --generate` tool, store the words
offline, and copy only the **xpub at `m/44'/60'/0'/0`** into
`CRYPTO_DEPOSIT_XPUB`. RektBull refuses to start deposits with an xprv, or
with a key at the wrong path.

You can reuse Soyjak's mnemonic, but a **separate one for RektBull** keeps the
two projects' funds and records apart, which is the point of the split.

### Moving funds out

RektBull has no code that sends funds. Deposits stay on their addresses until
you sweep them offline with the mnemonic (soyjak-agentic's sweeper pattern
can be adapted as an offline script later). Gas for the sweep comes from you,
not the user.

## Passes

Crypto can't safely pull a payment every month, so time is prepaid:
**Safety Pro**, `pro_30d` ($9) and `pro_365d` ($79), covers every Safety
desk check (fair use), 5 AI reports a month, the risk monitor (up to 3
wallets, checked daily; paused while no pass is active), and a 3% claim fee instead of 5%. Buying again while active extends from the current end date.
What a pass costs us to serve (AI reports, data plans, hosting) and when
it breaks even is worked out in the PR that introduced it (#10); the real
AI cost per report is recorded (`GET /v1/admin/provider-usage`, `ai`).
Renewal reminders by email are planned for when alert emails exist.

## Claim fees (Find money)

Checking a wallet for unclaimed airdrops and rewards is free. When RektBull
prepares a claim, the wallet is given the claim call(s) and, after them, a
plain ERC-20 `transfer` per token of **5% of what arrives** (3% with an
active Safety Pro pass) to `CLAIM_FEE_WALLET_EVM`. That's the whole fee
mechanism:

- **No approval, nothing held.** It's the user's own transfer, shown in the
  wallet before signing. RektBull never touches the claimed tokens.
- **Paid only for a claim that works.** The claim and the fee go out as one
  EIP-5792 bundle with `atomicRequired: true` where the wallet supports it.
  Other wallets send the claim first, then the fee (which the user can
  decline; we accept that rather than ask for an approval).
- **A share of what arrives**, from a simulation of the claim from the
  user's wallet, not of what the claim says (fee-on-transfer tokens, or a
  claim set to pay another address, show up there).
- **No fee** when the token can't be transferred yet (the fee transfer
  fails in simulation: points before launch, vesting), when the fee is
  worth less than the gas to send it, or when no fee wallet is set.
- **No price needed.** Tokens are often claimable before any exchange lists
  them, so the fee is a share of the tokens, not dollars, and has no cap.
- Each prepared claim is recorded (`claims`), and `POST /v1/claims/:id/confirm`
  reads the receipts for what arrived and what fee was paid.

The fee wallet fills with many different tokens: keep it cold and
receive-only (a Safe or hardware wallet); only the owner sells from it.
Tokens received as fees are likely income when they arrive in many places:
ask an accountant.

## Yield move fees

Yield proposals are part of Safety Pro; the free check shows a wallet's
positions, its idle money and how much more it could earn. Each move
RektBull prepares (withdraw, then deposit elsewhere, or a deposit from the
wallet) carries **0.1% of the amount moved**, in that asset, as a plain
`transfer` to `YIELD_FEE_WALLET_EVM` (the claim fee wallet when unset),
after the withdrawal and before the deposit. The same rules as the claim
fee: no approval, nothing held, bundled with the move (`atomicRequired`)
where the wallet can, skipped when worth less than its gas. The rules count
the fee: a move must earn back its gas and fee within 30 days. Withdrawals to
the wallet are free and never refused.

When automatic rebalancing is switched on (built, off), its fee is the same
0.1%, enforced onchain by the Yield Router: a constant cap in the contract,
paid only to the fixed fee wallet.

## NOWPayments (a second checkout)

RektBull's own top-ups (USDT/USDC to a deposit address) cost nothing, but a
deposit address holding USDT needs gas sent to it before it can be swept,
and only the payment chains' stablecoins are taken. NOWPayments' hosted
invoice takes whatever coins and networks are enabled in its dashboard and
forwards each payment to the payout wallet set there (RektBull's Safe). It
charges a fee per payment (shown in its dashboard); USDT/USDC top-ups stay
the no-fee option, shown first.

- `POST /v1/checkout/nowpayments` with `{ amount_cents }` (credits) or
  `{ product }` (a pass, at its price) returns NOWPayments' `invoice_url`.
- **Nothing is credited on a notification's word.** The notification to
  `/v1/nowpayments/ipn` must carry a valid `x-nowpayments-sig` (HMAC-SHA512
  of the body with its keys sorted, with the IPN secret); then the payment is
  read back from NOWPayments' API; it must be this order's (and this
  NOWPayments invoice's), priced at least the invoice in USD, and `finished`.
  The credit is one ledger entry (`nowpayments:<id>`), so it can't happen twice.
- The worker re-reads payments under way every 5 minutes, so a lost
  notification is caught up. `partially_paid` is never credited
  automatically: it shows as underpaid, and admins see it at
  `GET /v1/admin/hosted-invoices?status=underpaid`.
- Setup: a NOWPayments merchant account; enable only crypto (no card or fiat
  options, per CLAUDE.md); set the payout wallet to RektBull's Safe; set the
  IPN callback secret; secrets `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`,
  then `NOWPAYMENTS_ENABLED=true`. Test against the sandbox first
  (`NOWPAYMENTS_API_BASE=https://api-sandbox.nowpayments.io/v1`). Check the
  API's field names against NOWPayments' current documentation.

## Renewal reminders

Passes never renew by themselves, so the worker reminds (hourly check,
`payments/reminders.js`): 7 days before a pass ends, 1 day before, and when
it has ended, once each per end date, and not while a later pass extends it.
Each is a risk monitor alert (`pass_renewal`), so it goes to the account's
Telegram, email and push channels, with a link to renew.

## Refunds

Refunds are credits, never onchain transfers.

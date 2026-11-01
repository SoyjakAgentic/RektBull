# Payments

Crypto only. Three ways to pay, all ending in the same payment gate
(`src/payments/gate.js`), which charges only for runs that succeed.

| Rail | For | Account needed | Code |
|---|---|---|---|
| **x402** | Runs up to about $1, bots, other agents | No | `payments/x402.js`, `payments/facilitator.js` |
| **Credits** | Everything; the main rail on the website | Yes (wallet sign-in) | `payments/credits.js`, `invoices.js`, `watcher.js` |
| **Passes** | Unlimited use for a fixed time | Yes | `payments/passes.js` |

## Order a run is paid in

For a signed-in wallet: an active **pass** that covers the product, then the
**daily free allowance**, then **credits**. An `X-PAYMENT` header (x402) is
used first whenever it's sent. If nothing applies, the answer is
`402 Payment Required` with every option, including x402 terms in `accepts`.

If the run fails, the free use or the credits are given back and an x402
payment is never settled. Input is validated before anything is charged.

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
`pro_30d` ($9) and `pro_365d` ($79) give unlimited quick checks (fair use
200 a day). Buying again while active extends from the current end date.
Renewal reminders by email are planned for when alert emails exist.

## Refunds

Refunds are credits, never onchain transfers.

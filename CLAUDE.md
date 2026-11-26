# RektBull: working rules

- **Crypto payments only.** No card processors (no Stripe). Rails: x402 (USDC on
  Base), USDT/USDC credit top-ups, NOWPayments' hosted crypto checkout (no card
  or fiat options), prepaid passes, and in-kind fees on claims,
  yield moves, four.meme curve buys paid in BNB and Solana trades paid in SOL
  (a share of what's claimed, moved, spent or sold, in a plain transfer the
  user signs next to it; see docs/PAYMENTS.md), and a Hyperliquid builder
  code on perps (docs/HYPERLIQUID.md): the user signs `approveBuilderFee`
  once, a most-per-fill rate for RektBull's builder address, and Hyperliquid
  takes the fee (`HL_BUILDER_FEE_TENTHS_BPS`, 0.01% by default) from fills
  only; a fix from a RektBull proposal (a reduce-only stop-loss or reduction,
  docs/HYPERLIQUID.md) carries `HL_PROPOSAL_FEE_TENTHS_BPS` (0.05%) instead,
  accepted by the relay only on a live proposal's orders, and an order RektBull's agent places for automatic trading
  carries `HL_AUTO_FEE_TENTHS_BPS` (0.05%), accepted only from the trade service itself. That is a capped fee-on-fill permission, not a token approval and not
  a recurring pull: nothing is taken unless an order the user or their agent
  placed fills. A Polymarket builder code works the same way
  (docs/POLYMARKET.md): `POLYMARKET_BUILDER_CODE` is signed into every order the
  user's wallet signs, and Polymarket charges the builder fee (0.1% by
  default, the rates set on RektBull's builder profile) on fills only and pays
  it out. Polymarket winnings redeemed through RektBull carry a 10% share of
  the profit (payout minus what the shares cost; nothing on a loss), a pUSD
  transfer in the same batch the user signs. Orders from the AI (an approved proposal or an automatic
  entry) carry a second builder code instead once it's set, `POLYMARKET_AI_BUILDER_CODE` (1% taker, 0.5%
  maker by default), charged by Polymarket on fills only; until then they carry the main code. Acting on a Polymarket AI proposal costs $0.25 of
  Safety Pro AI credits; automatic entries also cost 1% of what fills (at least $0.25) in AI credits. Meme coin picks
  are free (docs/MEME_PROPOSALS.md): the trade's 1% fee pays for them. RektBull Points (docs/POINTS.md),
  a rebate of trading fees capped at 1,000,000,000 points, can buy prepaid
  passes. No recurring pulls and no token approvals asked of users for billing.
- **Never hold user funds or user keys.** Agents may prepare transactions; the
  user signs. Deposit addresses derive from `CRYPTO_DEPOSIT_XPUB` (public); the
  server must never receive an xprv or mnemonic.
- **Automatic trading uses session keys only** (docs/SESSION_KEYS.md): a
  limited, expiring, revocable permission the user signs. Its limits must be
  enforced onchain; no permission may allow transfers to any address but the
  user's own, except to the audited Trade Router contract, which must return
  the result to the user in the same transaction (Coinbase spend permissions),
  or the audited Meme Router, which fills only orders the user signed, at the
  user's own price, and returns the result in the same transaction
  (docs/MEME_ROUTER.md; on Solana, its twin the order program,
  docs/SOLANA_ORDERS.md).
  Never to any address RektBull controls. RektBull's own keys live in Google Cloud KMS, used only by the
  trade service.
  **The one exception, approved by the owner: Hyperliquid perps** (docs/HYPERLIQUID.md). Hyperliquid
  has no onchain spend limits for agents, so the permission is the user's `approveAgent` of RektBull's
  agent wallet ("rektbull-auto", KMS key, at most 30 days, revocable). Hyperliquid enforces that it can
  trade and never withdraw or transfer. The user's per-trade, 24-hour, leverage and market limits are
  enforced by the trade service (`src/hyperliquid/auto.js`), **not onchain**, and the page must say so,
  and that the most a user can lose is the margin in their Hyperliquid account. Every automatic order
  is immediate-or-cancel within `HL_AUTO_PRICE_BAND_BPS` of the mark, isolated margin, deep markets
  only, and passes the relay's rules (`relay.check`): no transfer or withdrawal is ever signed.
  **The second exception, approved by the owner: Polymarket Session Keys** (docs/POLYMARKET.md). The
  user's own key authorizes RektBull's Session Key (KMS key) on their Deposit Wallet; Polymarket fixes
  the term at 180 days and enforces that it can trade and never withdraw. The user's stop date,
  per-order and 24-hour limits and region are enforced by `src/polymarket/auto.js`, **not onchain**, and
  the page must say so, and the term, and that the most a user can lose is their Polymarket wallet. It
  only buys, from researched AI forecasts, fill-and-kill at no worse than the forecast's limit; stopping
  is never blocked. Its fee is charged to AI credits only on a fill.
- **Charge only for work delivered.** Every paid run goes through
  `src/payments/gate.js`: validate input before charging, refund credits and
  free uses on failure, settle x402 only after the run succeeds. In-kind fees
  are a share of what a simulated claim delivers or a move moves, bundled with
  it so they're paid only if it works (where the wallet can bundle).
- **Free data plans first.** Every external data call goes through
  `providers/usage.track()` and, where it can be reused, `lib/cache.cached()`.
  Add new providers the same way, with a fallback where one exists.
- **Every check names its source**, and a check that couldn't run says why.
  Never let an AI report fill gaps with guesses.
- **The Claude model is a setting** (`REPORT_MODEL`; the AI forecasts' `FORECAST_SCREEN_MODEL` and `FORECAST_MODEL`;
  `MEME_PROPOSAL_MODEL`), called only from `src/ai/claude.js`. AI proposals are suggestions the user approves and signs
  (docs/AI_PROPOSALS.md); meme picks are made by stated rules, and the AI only explains their facts (docs/MEME_PROPOSALS.md).
- Plain CommonJS on Node 22 (Hardhat 3 in `contracts/` needs 22.13+), no build step. Run `npm test` (and with
  `TEST_DATABASE_URL` for the end-to-end test) before pushing. The Solana program in `solana/` is Rust
  (Anchor 0.32): `cargo build-sbf --arch v0` then `cargo test -p rektbull-orders` there before pushing it.
- Schema changes are new files in `migrations/`, never edits to applied ones.

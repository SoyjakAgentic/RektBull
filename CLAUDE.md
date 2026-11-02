# RektBull: working rules

- **Crypto payments only.** No card processors (no Stripe). Rails: x402 (USDC on
  Base), USDT/USDC credit top-ups, prepaid passes, and in-kind fees on claims
  and yield moves (a share of what's claimed or moved, in a plain transfer the
  user signs next to it; see docs/PAYMENTS.md). No recurring pulls and no
  token approvals asked of users for billing.
- **Never hold user funds or user keys.** Agents may prepare transactions; the
  user signs. Deposit addresses derive from `CRYPTO_DEPOSIT_XPUB` (public); the
  server must never receive an xprv or mnemonic.
- **Automatic trading uses session keys only** (docs/SESSION_KEYS.md): a
  limited, expiring, revocable permission the user signs. Its limits must be
  enforced onchain; no permission may allow transfers to any address but the
  user's own, except to the audited Trade Router contract, which must return
  the result to the user in the same transaction (Coinbase spend permissions).
  Never to any address RektBull controls. RektBull's own keys live in Google Cloud KMS, used only by the
  trade service.
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
- **The Claude model is a setting** (`REPORT_MODEL`), called only from `src/ai/claude.js`.
- Plain CommonJS on Node 22 (Hardhat 3 in `contracts/` needs 22.13+), no build step. Run `npm test` (and with
  `TEST_DATABASE_URL` for the end-to-end test) before pushing.
- Schema changes are new files in `migrations/`, never edits to applied ones.

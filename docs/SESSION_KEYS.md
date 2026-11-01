# Automatic trading with session keys: Design

*Status: milestone 0 built. The Trade Router and its break-it tests are in
`contracts/` (23 tests, all passing, against MetaMask's real deployed
contracts on a copy of Base Sepolia). Not audited; not on mainnet. Decided: users keep their own wallets,
and RektBull trades for them through a limited, revocable permission
("session key"). RektBull never holds user funds and can never withdraw.*

---

## 1. The promise, and what enforces it

**"We can't rug you."** Users' funds stay in their own wallets. RektBull gets
a permission that the user signs and can revoke at any time. The limits are
enforced **onchain by audited contracts**, not by RektBull's code, so even a
fully hacked RektBull can't go past them.

| Guarantee | Enforced by | If RektBull is hacked |
|---|---|---|
| Only RektBull's session key can use the permission | Onchain (redeemer restriction) | — |
| It expires (30 days at most) and the user can revoke it any time | Onchain (expiry; user disables the delegation) | Revocation still works: it's the user's own transaction |
| It can only call the **RektBull Trade Router** (section 2) | Onchain (allowed targets and methods) | Can't call anything else |
| Bought tokens go only to the user's own wallet; the fee is at most 1% and goes only to RektBull's fixed fee wallet; the price can't be far worse than an onchain reference price | Onchain (the Trade Router's fixed rules; no transfer methods allowed) | **Can't withdraw, and can't route value out through fees or bad prices** |
| Spending is capped per trade and per day/week, per token | Onchain (period spending limits) | Worst case: bad trades up to the cap |
| Due diligence, honeypot and tax checks, slippage, approve-each mode | RektBull's trade service (off-chain) | These could be bypassed |

**The remaining risk, stated plainly:** a hacked RektBull could make poor
trades with the user's own money (buying a token that later goes to zero),
inside the cap, and the tokens bought would still land in the user's wallet. The grant screen shows that worst case in
dollars: *"At most $10,000 a day can be traded, at most $500 per trade, only
on 0x, only back into this wallet, until 8 December. Revoke any time."*

### Default limits (the user can change every one)

| Limit | Default | Notes |
|---|---|---|
| Per day | **$10,000** | Trading volume, not funds: the dollar value of all trades in the day, at the reference price. Enforced onchain by the Trade Router |
| Per trade | **$500** | Enforced onchain by the Trade Router |
| Expiry | 7 days | At most 30 |
| Mode | Approve each | Autonomous is opt-in |

Users set their own limits on the grant screen, with **no upper ceiling**.
A higher limit means a bigger worst case, so the screen shows it in dollars
before they sign, and any limit above the default needs an extra
confirmation: the user types the daily amount back (for example "25000") to
confirm they understand that much can be traded in a day.

**Where they set them:** on the screen where they turn on automatic trading
(website, not built yet). Their wallet then signs `setLimits` on the Trade
Router, so the limits are written onchain by the user's own wallet; RektBull's
permission can't change them. The contract has no maximum. Changing limits
later, or "Stop trading" (`revoke`), is the same: one signature from the user.

## 2. EVM chains (Base first, then Ethereum and Arbitrum)

**Standards (checked November 2026):**
- **EIP-7702** has been live since the Pectra upgrade (May 2025). It lets an
  ordinary wallet (an EOA) become a smart account at the same address, so
  users don't move funds anywhere.
- **ERC-7710** (delegations, the contract side) and **ERC-7715** (the wallet's
  "grant permission" prompt) are how a dapp asks for a limited permission.
  ERC-7715 is **still a draft**, and its method name has changed between
  drafts (`wallet_grantPermissions` became `wallet_requestExecutionPermissions`).
- **MetaMask** is the most complete implementation: its Delegation Toolkit
  (Smart Accounts Kit) supports ERC-7710 delegations with "caveat enforcers"
  (onchain rules attached to a delegation), and "Advanced Permissions" for
  ERC-7715. Biconomy and Rhinestone offer **Smart Sessions** (ERC-7579 modules)
  for Safe and Kernel accounts.

### Wallets supported

Each wallet type grants permissions differently, so the trade service has
one internal "permission" interface with an adapter per wallet type. The
rule is the same for all of them: **a wallet is only offered for automatic
trading once milestone 0's break-it tests pass on it.** Until then it works
in approve-each mode, where the user signs every trade.

| Wallet | Chains | How the permission works | What to prove first |
|---|---|---|---|
| **MetaMask** | EVM | ERC-7710 delegation with caveat enforcers, on an account upgraded with EIP-7702 (MetaMask Delegation Framework; ERC-7715 "Advanced Permissions" prompt) | All six caveats below |
| **Coinbase Smart Wallet** | EVM (Base first) | Already a smart account. Coinbase's own **Spend Permissions** let a spender *pull tokens to itself*, which is a withdrawal power, so they are **not** used. It qualifies only through a permission that can call a swap contract and require the output back in the wallet (ERC-7715 support, if available) | That such a permission exists and enforces "output back to the wallet" |
| **Safe** | EVM | **Smart Sessions** module (Rhinestone/Biconomy, ERC-7579) through the Safe7579 adapter; the Safe's owners install it in one Safe transaction | Same six guarantees with Smart Sessions policies |
| **Phantom** | Solana (and EVM) | On Solana: a smart wallet (Squads Smart Account or Swig) controlled by the user's Phantom key, with a session-key role (section 3). On EVM: only if Phantom supports EIP-7702 upgrades or ERC-7715; otherwise approve-each | Section 3's devnet proof |

**Order:** MetaMask (the reference implementation) → Safe → Coinbase Smart
Wallet → Phantom (with Solana).

### Why a RektBull Trade Router contract is needed

A delegation's caveats are fixed when the user signs, and they can check
*which* contract is called but not the inside of a swap's calldata. If the
permission allowed calling 0x directly, a hacked RektBull could build a swap
whose **fee recipient** is its own address with a very high fee, or whose
price is deliberately terrible, and drain up to the cap that way. Allowing
only "the exchange" isn't enough to keep the "can't rug you" promise.

So the only contract a permission may call is a small **RektBull Trade
Router**: immutable (no admin, no upgrades), open source, and audited before
launch. It calls 0x (EVM) on the user's behalf and enforces, onchain, on
every trade:
- the bought tokens are sent to the **user's own account** (the caller), nowhere else;
- the fee is **at most 1%** (a constant in the contract), paid only to the
  **fixed fee wallet** written into the contract;
- the output is no worse than an **onchain reference price** (a Chainlink
  feed or a pool TWAP) by more than a fixed slippage bound, so a deliberately
  bad price can't move value out. Tokens without a reference price fall back
  to approve-each;
- the input never exceeds the per-trade limit encoded in the user's grant.

### The caveats on every RektBull delegation

Exact enforcer names and parameters to be confirmed in milestone 0:
1. **Redeemer:** only RektBull's session-key address may redeem it.
2. **Timestamp:** valid from now until the expiry the user chose (at most 30 days).
3. **Allowed targets and methods:** the Trade Router's swap function, and
   `approve` on the allowed tokens to the Trade Router only.
4. **Period spending limits:** per token, per day or week, from the user's caps.
5. **Balance change:** the account's balance of the token being bought must
   go up after each trade (a second check that the output came back).
6. **Limited calls:** a ceiling on trades per period (optional).

**Why not a plain token approval?** Approving RektBull to spend a token lets
the spender send it *anywhere*. That would be a withdrawal power, which is
exactly what this design rules out.

### The 1% fee

- **1% of every trade, buy or sell** (`crypto_swap_fee_bps = 100`, the same
  as Soyjak), set as a setting so it can be lowered later.
- **Taken inside the swap**, in the token being sold, and sent straight to
  the fee wallet by the Trade Router. The user never pays a separate charge
  and never approves RektBull to take a fee.
- **Capped onchain at 1%** by the Trade Router, so even a hacked RektBull
  can't charge more. Lowering it is a setting; raising it above 1% would
  need a new router and new grants from every user.
- **Shown before every trade:** "Fee: $1.00 (1%)." In approve-each mode the
  user sees it on the approval; in autonomous mode it appears in the trade
  log and the daily summary.
- **Gas** is paid by RektBull's gas wallet and covered by the fee.
- **For comparison:** wallet swap features commonly charge just under 1%
  (MetaMask Swaps and Phantom were around 0.85–0.875% when last checked).
  1% is in line for a service that also runs the safety checks; check
  current competitor fees before launch.
- 0x may charge its own fee on some pairs on its free plan; check before
  launch, since it adds to the user's cost.

### What building milestone 0 changed

- **Limits live in the Trade Router, not in the delegation.** The user sets
  them by calling `setLimits` from their own wallet, in USD, valued at the
  Chainlink price. The delegation allows only the router's `swap`, so RektBull
  can't change them. One standing approval to the router is safe, because the
  router only ever pulls from the account calling it.
- **Caveats used:** Redeemer, Timestamp, AllowedTargets (router only),
  AllowedMethods (`swap` only). Spending-limit enforcers and the
  balance-change check weren't needed: the router does both, with prices.
- **The worst case of a bad price is bounded:** a hacked RektBull could take
  at most the price bound (2%) on each trade, within the limits. Lower the bound
  for liquid pairs if that's too much.
- **MetaMask can pause its DelegationManager** (it has an owner). A pause
  stops automatic trading, but can't move anyone's funds.
- Base Sepolia's tokens, price feeds and exchange are test mocks; mainnet
  uses real Chainlink feeds and 0x.

## 3. Solana (second)

Solana has no EIP-7702 equivalent; the user needs a smart wallet program.
Candidates:
- **Squads Smart Account:** session keys, passkeys, programmable policies;
  audited by OtterSec and Certora and formally verified by Certora.
- **Swig:** a smart wallet with role-based session keys limited by amount
  and time; launched May 2025.

**Rejected:** SPL token delegates. A delegate can transfer to any address,
so it's a withdrawal power.

Before choosing, prove on devnet that the permission can be limited to
swaps through a RektBull Trade Router program (the same rules as on EVM:
output to the user, fee at most 1% to the fixed fee wallet, a reference-price
check), with per-period caps. If neither can enforce "output back to the user" onchain, Solana stays
**approve-each only**: the user signs every trade.

## 4. Where keys live (Google Cloud KMS)

KMS holds only RektBull's **own** few keys, never user keys, so the per-key
cost is a few dollars a month in total.

| Key | KMS key | Who may use it |
|---|---|---|
| Session-key redeemer (EVM), one per chain environment | HSM, `EC_SIGN_SECP256K1_SHA256` | Trade service's service account only (`roles/cloudkms.signer` on that key alone) |
| Gas wallet (pays to submit redemptions) | HSM, secp256k1 | Trade service only |
| Fee wallet, treasury | Not in KMS: receive-only, kept cold (hardware wallet or Safe) | Nobody online |

- Signing: KMS returns a DER-encoded ECDSA signature over a digest. The trade
  service converts it to `r, s`, normalises `s` to the low half (Ethereum
  rejects high-`s`), and finds `v` by recovering against the key's known
  address.
- **Rotation:** delegations name the redeemer address, so a new key means new
  grants. Every grant expires within 30 days, and the old key keeps working
  until its grants expire, so rotation needs no re-grant drive. Option for
  later: delegate to a small RektBull redeemer contract whose owner key can
  be rotated without re-grants.
- **Audit:** KMS's Data Access audit logs record every signature. Each one is
  matched against a `trades` row, and any unmatched signature raises an alert.
- **Leaked or misused session key:** bounded by every user's onchain caveats
  (section 1). The response is to disable the key's IAM binding at once, which
  stops all trading. User funds are never at risk of withdrawal.

## 5. Architecture

```
 user's wallet ──grant (EIP-712 signature)──► rektbull-api ──► permissions table
                                                 │
 agents / user ──trade intent──► trade_intents (Postgres queue)
                                                 │
                                   rektbull-trade (separate service)
                                   ├─ rules: due diligence, tax, honeypot,
                                   │         slippage, caps  (ported from Soyjak)
                                   ├─ quote: 0x (EVM), Jupiter (Solana)
                                   ├─ simulate the exact redemption
                                   ├─ sign with KMS (session key)
                                   ├─ send: Flashbots Protect on Ethereum,
                                   │        the sequencer on Base/Arbitrum
                                   └─ positions + exit watcher (ported)
```

- **Separate service, separate identity.** `rektbull-trade` is its own Cloud
  Run service with its own service account. Only it has KMS permission; the
  public API has none. They talk only through the database queue, so the
  public-facing service can't sign anything even if it's compromised.
- **Modes,** as in Soyjak: **approve each** (the trade waits as a proposal;
  tapping Approve re-checks on a fresh quote, then RektBull redeems), or
  **autonomous** (checked and sent at once). The onchain limits apply in both.
- **Fees:** a flat fee taken inside the swap (0x `swapFeeBps` to the fee
  wallet), as Soyjak does. Gas is paid by RektBull's gas wallet and covered by
  the fee.
- **Revocation:** the user revokes onchain (disable the delegation), and
  RektBull's "Stop trading" button also stops it off-chain at once. A watcher
  checks each grant's onchain status before every trade.

## 6. What comes from Soyjak

| Soyjak | Here |
|---|---|
| `swapRules.js`, `tradingCaps` (every check a trade must pass) | Ported into the trade service as the off-chain rules |
| `tradePositions.js`, position/exit watcher | Ported |
| `swapTrading.js` | Rewritten: redeem a delegation through the Trade Router instead of signing from a custodial wallet. The 1% fee (Soyjak §638) moves into the router |
| `defiCalls.js` (rebalancer calls, built but unsigned) | Later, as delegations to the lending venues |
| `walletCustody.js`, `userWalletProvisioning.js`, `walletWithdrawals.js` | **Not needed:** users hold their own wallets, so there is nothing to withdraw |

## 7. Milestones

| # | Milestone | Done when |
|---|---|---|
| 0 | **Testnet spike (Base Sepolia), MetaMask** | An EIP-7702 account grants a delegation with all six caveats; RektBull redeems a 0x swap through it; **fork tests that try to break each guarantee fail**: withdraw to another address, exceed the cap, call another contract, use it after expiry, use it after revocation, redeem with a different key, **set the fee recipient to another address, charge more than 1%, trade far below the reference price** |
| 0b | **Trade Router audit** | An external audit of the router contract, with every finding fixed, before any mainnet trade |
| 1 | Trade service, KMS signer, permissions registry, approve-each mode on Base, for all four wallets | One real approve-each trade on Base mainnet with a small cap |
| 2 | Autonomous mode for MetaMask, rules port, positions and exits | Soyjak's swap checks pass the same test cases here |
| 3 | Safe, then Coinbase Smart Wallet | Milestone 0's break-it tests pass on each |
| 4 | Ethereum and Arbitrum (Flashbots on Ethereum) | — |
| 5 | Solana with Phantom (Squads Smart Account or Swig) | The devnet proof in section 3 |

## 8. Open questions

1. ~~Wallets~~ **Decided:** MetaMask, Phantom, Coinbase Smart Wallet and Safe (section 2).
2. ~~Default limits~~ **Decided:** $10,000 a day and $500 per trade by default; users set their own (section 1).
3. **Router audit:** an external audit of a small contract like the Trade
   Router typically takes a few weeks; budget for it before mainnet.
4. ~~Upper limit~~ **Decided:** no ceiling. Any limit is allowed after the extra confirmation (section 1).
5. **Legal:** non-custodial delegated trading is generally treated
   differently from custody, but automatic trading for users can still be
   regulated as investment management or advice in some places. Get advice
   before launch.

## Sources

- [ERC-7715 explained](https://eco.com/support/en/articles/11953354-erc-7715-explained-wallet-permissions-sessions-and-subscriptions)
- [ERC-7715 wallet execution permissions](https://tokentoolhub.com/erc-7715-wallet-execution-permissions-scoped-authority-expiry-and-revocation/)
- [EIP-7702 deep dive 2026](https://eco.com/support/en/articles/15254037-erc-7702-deep-dive-2026-eoa-becomes-smart-wallet)
- [MetaMask Delegation Toolkit](https://metamask.io/developer/delegation-toolkit)
- [Biconomy EIP-7702 guide](https://blog.biconomy.io/a-comprehensive-eip-7702-guide-for-apps/)
- [Squads Smart Account program](https://www.github.com/Squads-Protocol/smart-account-program)
- [Swig launch](https://x.com/solana/status/1924885317250634026)
- [Cloud KMS algorithms](https://docs.cloud.google.com/kms/docs/algorithms?hl=de)

Check each standard's current text and each wallet's docs at build time:
several sources above are secondary, and ERC-7715 is still changing.

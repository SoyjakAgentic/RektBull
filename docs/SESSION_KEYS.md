# Automatic trading with session keys: Design

*Status: design, nothing built yet. Decided: users keep their own wallets,
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
| It can only call the allowed exchange contracts and methods | Onchain (allowed targets and methods) | Can't call anything else |
| It can't send funds anywhere except back to the user's own wallet | Onchain (no transfer methods allowed; output must arrive in the user's account) | **Can't withdraw or steal** |
| Spending is capped per trade and per day/week, per token | Onchain (period spending limits) | Worst case: bad trades up to the cap |
| Due diligence, honeypot and tax checks, slippage, approve-each mode | RektBull's trade service (off-chain) | These could be bypassed |

**The remaining risk, stated plainly:** a hacked RektBull could make poor
trades with the user's own money, inside the cap, and the proceeds would
still land in the user's wallet. The grant screen shows that worst case in
dollars: *"At most $1,000 a day can be traded, at most $100 per trade, only
on 0x, only back into this wallet, until 8 December. Revoke any time."*

### Default limits (the user can change every one)

| Limit | Default | Notes |
|---|---|---|
| Per day | **$1,000** | Enforced onchain as a period spending limit |
| Per trade | **$100** | Checked by the trade service; onchain where the wallet type supports it |
| Expiry | 7 days | At most 30 |
| Mode | Approve each | Autonomous is opt-in |

Users set their own limits on the grant screen. A higher limit means a
bigger worst case, so the screen shows it in dollars before they sign, and
any limit above the default needs an extra confirmation.

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

**The caveats on every RektBull delegation** (exact enforcer names and
parameters to be confirmed in the testnet spike, milestone 0):
1. **Redeemer:** only RektBull's session-key address may redeem it.
2. **Timestamp:** valid from now until the expiry the user chose (at most 30 days).
3. **Allowed targets and methods:** the 0x settlement contract (swaps), and
   `approve` on the allowed tokens to that contract only.
4. **Period spending limits:** per token, per day or week, from the user's caps.
5. **Balance change:** after each trade, the account's balance of the token
   being bought must have gone up by at least the quote's minimum. This is
   what stops swap calldata from sending the output anywhere else.
6. **Limited calls:** a ceiling on trades per period (optional).

**Why not a plain token approval?** Approving RektBull to spend a token lets
the spender send it *anywhere*. That would be a withdrawal power, which is
exactly what this design rules out.

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
Jupiter swaps whose output returns to the user's own wallet, with per-period
caps. If neither can enforce "output back to the user" onchain, Solana stays
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
| `swapTrading.js` | Rewritten: redeem a delegation instead of signing from a custodial wallet |
| `defiCalls.js` (rebalancer calls, built but unsigned) | Later, as delegations to the lending venues |
| `walletCustody.js`, `userWalletProvisioning.js`, `walletWithdrawals.js` | **Not needed:** users hold their own wallets, so there is nothing to withdraw |

## 7. Milestones

| # | Milestone | Done when |
|---|---|---|
| 0 | **Testnet spike (Base Sepolia), MetaMask** | An EIP-7702 account grants a delegation with all six caveats; RektBull redeems a 0x swap through it; **fork tests that try to break each guarantee fail**: withdraw to another address, exceed the cap, call another contract, use it after expiry, use it after revocation, redeem with a different key |
| 1 | Trade service, KMS signer, permissions registry, approve-each mode on Base, for all four wallets | One real approve-each trade on Base mainnet with a small cap |
| 2 | Autonomous mode for MetaMask, rules port, positions and exits | Soyjak's swap checks pass the same test cases here |
| 3 | Safe, then Coinbase Smart Wallet | Milestone 0's break-it tests pass on each |
| 4 | Ethereum and Arbitrum (Flashbots on Ethereum) | — |
| 5 | Solana with Phantom (Squads Smart Account or Swig) | The devnet proof in section 3 |

## 8. Open questions

1. ~~Wallets~~ **Decided:** MetaMask, Phantom, Coinbase Smart Wallet and Safe (section 2).
2. ~~Default limits~~ **Decided:** $1,000 a day and $100 per trade by default; users set their own (section 1).
3. **Upper limit:** should RektBull refuse limits above some ceiling (say
   $25,000 a day), or allow any limit after the extra confirmation?
4. **Legal:** non-custodial delegated trading is generally treated
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

# RektBull: audit brief

*For the external security audit (milestone 0b in [SESSION_KEYS.md](SESSION_KEYS.md)).
Nothing here may hold real funds until this audit is done and every finding is
fixed or explicitly accepted.*

## 1. What to audit

| File | nSLOC | Lines |
|---|---|---|
| `contracts/contracts/RektBullTradeRouter.sol` | 227 | 327 |
| `contracts/contracts/RektBullSafeModule.sol` | 46 | 81 |
| `contracts/contracts/RektBullYieldRouter.sol` (automatic yield rebalancing; [YIELD_ROUTER.md](YIELD_ROUTER.md) states its guarantees, `contracts/test/yieldRouter.test.js` tries to break them on a Base mainnet fork; the pre-audit fixes of 12 November 2026, the best-venue rule for deposits, the fee-free redeposit window and the Aave health-factor floor, and the accepted rate-manipulation risk are in YIELD_ROUTER.md) | — | ~310 |
| `contracts/contracts/RektBullMemeRouter.sol` (automatic meme trades from orders the user signs; [MEME_ROUTER.md](MEME_ROUTER.md) states its guarantees, `contracts/test/memeRouter.test.js` tries to break them; added after this brief, for the same engagement) | ~190 | 267 |
| `solana/programs/rektbull-orders/src/lib.rs` (Solana, Anchor 0.32: the Meme Router's twin for pump.fun, PumpSwap and Jupiter; [SOLANA_ORDERS.md](SOLANA_ORDERS.md) states its guarantees; `tests/orders.rs` and `tests/pump_fun.rs` try to break them, `tests/venues.rs` checks PumpSwap and Jupiter; a Solana specialist may be a separate engagement) | — | 549 |
| **Total** | **273 + the Yield and Meme Routers** | |

- **Commit:** `31c9c8c` on `main` of `SoyjakAgentic/RektBull` (or the commit we
  freeze when the audit is booked).
- **Compiler:** solc 0.8.24, optimizer on (200 runs), `viaIR: true`, EVM target `cancun`.
- **Dependencies:** OpenZeppelin Contracts 5.6.1 (`SafeERC20`, `ReentrancyGuard`,
  `IERC20Metadata`).
- **Out of scope** (but their integration with ours is in scope):
  - MetaMask Delegation Framework v1.3.0: `DelegationManager`,
    `EIP7702StatelessDeleGator` and the Redeemer, Timestamp, AllowedTargets and
    AllowedMethods enforcers.
  - Safe 1.4.1.
  - Coinbase Smart Wallet and Coinbase's Spend Permission Manager.
  - 0x's AllowanceHolder.
  - Aave v3, Compound v3 and Spark's sUSDC vaults (the Yield Router's venues).
  - Chainlink feeds.
  - Test mocks (`contracts/contracts/test/Mocks.sol`).
  - `contracts/contracts/SignInCheck6492.sol`: optional, low priority. It is
    never deployed and holds nothing; the server runs it in a read-only
    `eth_call` to check sign-in signatures from smart wallets that aren't
    deployed yet (EIP-6492). It affects sign-in only, not funds.
  - The off-chain service (`src/`).

## 2. What the system does

RektBull trades for users from **their own wallets**, through a limited,
revocable permission they sign. RektBull never holds user funds or keys. The
Trade Router is the only contract any permission lets RektBull call, and it is
what makes the promise "we can't rug you" true onchain.

**Actors**
- **The trading account:** the user's wallet. It is one of:
  - a MetaMask smart account (an EOA upgraded with EIP-7702);
  - a Safe;
  - a Coinbase Smart Wallet.
- **RektBull's session key:** one key, held in Google Cloud KMS (HSM),
  used by RektBull's trade service. **Assume it is compromised**: that is the
  main threat this audit is about.
- **Fee wallet:** fixed at deployment (a Safe or hardware wallet).
- **Venues:** exchanges allowlisted at deployment. On mainnet that is 0x's
  AllowanceHolder, `0x0000000000001fF3684f28c67538d4D072C22734`.
- **Price feeds:** Chainlink TOKEN/USD feeds per token, plus the L2 sequencer
  uptime feed. All are fixed at deployment.

**The three ways a trade reaches the router**

| Wallet | Path | Who is `account` |
|---|---|---|
| MetaMask (EIP-7702) | Session key → `DelegationManager.redeemDelegations` → user's account → `router.swap` | `msg.sender` (the user's account) |
| Safe | Session key → `RektBullSafeModule.swap(safe, p)` → `Safe.execTransactionFromModuleReturnData(router, 0, swap(p), CALL)` → `router.swap` | `msg.sender` (the Safe) |
| Coinbase Smart Wallet | Session key (named by the wallet via `setOperator`) → `router.swapWithSpendPermission(sp, p)` → `SpendPermissionManager.spend(sp, amountIn)` pulls into the router | `sp.account` |

**The MetaMask delegation's caveats** (built and checked by RektBull's
service, enforced by MetaMask's contracts):
- Redeemer: only the session key may redeem it.
- Timestamp: it expires within 30 days.
- AllowedTargets: the router only.
- AllowedMethods: `swap` only.

**The account's own setup:** it approves the router (or grants Coinbase spend
permissions to it) and calls `setLimits`. Only the account can set its limits,
operator or revocation, so the session key can never call `setLimits`,
`setOperator` or `revoke` for it.

## 3. The guarantees to verify

These must hold **even with RektBull's session key and backend fully
compromised**, and with the venue calldata entirely attacker-chosen (within
an allowlisted venue).

| # | Guarantee | Where |
|---|---|---|
| G1 | Funds are only ever taken from the trading account, and only for a trade that account allowed: `swap` pulls from `msg.sender`; `swapWithSpendPermission` only for `sp.account`, only when `msg.sender == operatorOf[sp.account]` (which only the account can set), only when `sp.spender == router` and `sp.token == tokenIn` | `swap`, `swapWithSpendPermission` |
| G2 | All output goes to the trading account, and any input the venue didn't use goes back to it. The router keeps nothing between transactions | `_trade` |
| G3 | The fee is at most 1% (`MAX_FEE_BPS`, a constant), paid only to the immutable `FEE_WALLET` | constructor, `_trade` |
| G4 | The output is at least the Chainlink fair value less `MAX_SLIPPAGE_BPS` (≤ 5%, deployed at 2%), and at least the caller's `minAmountOut`. Calldata that pays someone else, pays less, or takes more than approved must revert the whole trade | `_trade` |
| G5 | Every trade fits the account's own limits: per-trade USD, per-period USD, expiry. Selling up to what this router bought for the account (with trades that counted) is exempt; everything else counts | `_check`, `_spend`, `_trade` |
| G6 | Prices are fresh (per-token max age), positive, and not used while the L2 sequencer is down or within an hour of restarting | `_price`, `_checkSequencer` |
| G7 | No owner, admin, upgrade, pause or setter for the fee, fee wallet, venues, tokens or feeds. Every write function only changes the caller's own state, or trades for an account under G1 | whole contract |
| G8 | Safe module: only the Safe's named session key, before its expiry (≤ 30 days), can make the Safe call exactly `router.swap(p)`, with value 0 and operation CALL. Only the Safe itself can set or revoke its session | `RektBullSafeModule` |
| G9 | Each venue approval is for exactly the trade amount and is reset to 0 after the call | `_trade` |

**Accepted worst case when the session key is compromised:**
- trades within the user's limits, each at up to the slippage bound (2%) below
  fair value, plus the 1% fee;
- buying a token that later loses value.

**Never acceptable:** any transfer to an address other than the account, the
fee wallet, or the venue during a trade.

## 4. Threats and specific questions

Please look hard at these:

1. **0x AllowanceHolder `exec` forwards to an arbitrary `target` chosen in the
   calldata,** with a temporary allowance for an arbitrary `operator`. An
   attacker's target can therefore pull up to the approved amount from the
   router. We rely on the output check in `_trade` (G4) to revert any trade
   whose output falls short. Is there any way to take the approved input and
   still pass the check: reentrancy, tokens arriving from elsewhere, or
   `balanceOf` games?
2. **Balance-delta accounting.** `received`, `amountOut` and `leftover` are all
   balance differences. Consider fee-on-transfer, rebasing and ERC-777-style
   tokens. Tokens are allowlisted with price feeds, so which token properties
   should we require when listing one?
3. **Reentrancy.** `swap` and `swapWithSpendPermission` are `nonReentrant`.
   `setLimits`, `setOperator` and `revoke` are not. Can a venue or token hook
   call them mid-trade on the account's behalf? We believe not, because they
   act on `msg.sender`, which would be the venue or token.
4. **The limits.**
   - Can the period window be gamed (`periodStartedAt` resets on the first trade
     after the period ends)?
   - Can rounding in `valueUsd` let many tiny trades count as $0?
   - Can the sell exemption (`boughtByRouter`) be inflated? For example, by
     buying with exempt funds, by trades whose output comes from elsewhere, or
     by wash trades between two router tokens.
5. **`amountForUsd` / `valueUsd`:** precision, overflow for 18-decimal tokens
   with 8-decimal feeds, and the order of multiplication and division.
6. **Oracles:** the staleness thresholds (section 6), negative or zero answers,
   the sequencer grace period, and feed decimals.
7. **`swapWithSpendPermission`:**
   - Anyone can pass any `sp`. Is the `operatorOf[sp.account]` check enough?
   - What if the account names an operator and later its Coinbase permission
     is replaced?
   - Is there an interaction with `SpendPermissionManager.spend`'s own checks
     (period, allowance, revocation) that we've missed?
8. **The Safe module:**
   - `abi.decode(ret, (uint256))` on the router's return data.
   - What happens if the module is enabled on a Safe that never set a session.
   - Is a 30-day maximum session sensible?
9. **The MetaMask path:**
   - With only the four caveats above, can a redemption reach anything but
     `router.swap` (for example through a batch execution mode)?
   - Our service only builds single-mode executions; please confirm the caveats
     themselves enforce this.
10. **Griefing.**
    - Can someone make a user's trades fail, or burn their period allowance,
      without the session key?
    - Can someone trigger trades on a Coinbase account without being its
      operator?

## 5. Tests and how to run them

```bash
cd contracts
npm install
npm test        # 53 tests on a fork of Base Sepolia
```

- `test/breakIt.test.js`: 27 tests for the router and the MetaMask path,
  against MetaMask's real deployed contracts.
- `test/walletsBreakIt.test.js`: 19 tests for the Safe module, against real
  Safe 1.4.1, and the Coinbase path, against Coinbase's real factory and Spend
  Permission Manager.
- `test/signInCheck.test.js`: 7 tests for the sign-in check (optional scope).
- `../test/autonomous.e2e.js`: the off-chain service driving all three wallets
  end to end on a fork. Context only; the service is out of scope.

Live on Base Sepolia (test tokens, feeds and exchange): see
`contracts/deployments/base-sepolia.json` and the contracts README.

## 6. Mainnet deployment (Base, then Ethereum and Arbitrum)

Every value is in `contracts/config/base.json`, checked onchain on 2026-11-08.
The deployment script checks every one again, including each feed's heartbeat
measured from its round history, and refuses to send anything if one is off
([ROUTER_DEPLOYMENT.md](ROUTER_DEPLOYMENT.md)).

| Parameter | Value |
|---|---|
| `feeBps` | 100 (1%) |
| `maxSlippageBps` | 200 (2%) |
| `sequencerUptimeFeed` | `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` (L2 Sequencer Uptime Status Feed) |
| `spendPermissionManager` | `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` (Coinbase) |
| venues | `0x0000000000001fF3684f28c67538d4D072C22734` (0x AllowanceHolder) |
| USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | feed `0x7e860098F58bBFC8648a4311b374B1D669a2bc6B` (USDC / USD), heartbeat 24 h, `maxAge` 90000 (25 h) |
| WETH `0x4200000000000000000000000000000000000006` | feed `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` (ETH / USD), heartbeat 20 min, `maxAge` 1800 (30 min) |
| cbBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` (Coinbase Wrapped BTC, 8 decimals) | feed `0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D` (cbBTC / USD), heartbeat 20 min, `maxAge` 1800 (30 min) |
| `feeWallet` | A Safe controlled by RektBull's owners, given at deployment; the script refuses anything that isn't a Safe |

Heartbeats were measured from each feed's last 12 rounds (the longest gaps
were 24 h, 20 min and 20 min).

The Safe Module is deployed in the same run, pointing at the router. Both are
deployed from a hardware wallet through Frame (no key on the computer); the
deploying account has no power over either contract afterwards. After
deploying, `npm run verify:base` compares the onchain code with the compiled
audited source and reads back every setting; then the source is verified on
Basescan.

### Ethereum and Arbitrum

The same contracts, deployed once per chain with that chain's settings
(`contracts/config/ethereum.json`, `arbitrum.json`, checked onchain on
2026-11-11; heartbeats as published in Chainlink's reference data directory
and measured from the last 12 rounds). Fee 1%, price bound 2%, the same venue
and Spend Permission Manager addresses, a fees Safe on each chain.

| Chain | `sequencerUptimeFeed` | Tokens (feed heartbeat → `maxAge`) |
|---|---|---|
| Ethereum (1) | `address(0)`: no sequencer; `_checkSequencer` returns early | USDC (23 h → 25 h), USDT (24 h → 25 h), DAI (1 h → 90 min), WETH via ETH / USD (1 h → 90 min), cbBTC (24 h → 25 h) |
| Arbitrum (42161) | `0xFdB631F5EE196F0ed6FAa767959853A9F217697D` | USDC (4 min → 8 min), USD₮0 via USDT / USD (4 min → 8 min), WETH via ETH / USD (29 min → 45 min), WBTC (24 h → 25 h), ARB (24 h → 25 h) |

Two points for review: the zero sequencer address on Ethereum (the
constructor allows it, and the Base Sepolia deployment already runs with it),
and USDT's approval behaviour on Ethereum (the router uses SafeERC20's
`forceApprove`, which handles a token that requires a zero allowance first).

## 7. Practicalities

- **Size:** 273 nSLOC. Small, but security-critical and integration-heavy.
- **Ask firms for:** a fixed quote, the timeline, one fix-review round, and a
  public report.
- **Shortlist:** firms that have audited delegation/session-key or DEX-router
  code. Ask each for comparable past reports.
- **Contact:** the repository owner (SoyjakAgentic).

## 8. Changes since the November 2026 audit

The November 2026 audit covered the **Trade Router** (at commit `31c9c8c`)
and the **Yield Router** (the owner, 12 November 2026). The **Safe Module**
was not covered. Before any deployment, the next engagement should cover:

- **Trade Router, finding H-1 (High), fixed.** Found by the pre-audit checks
  (an AI security review with a working proof, 12 November 2026); it is the
  case asked about in section 4, question 4. The output of every trade was
  credited to `boughtByRouter`, including trades that were themselves exempt.
  So selling what the router bought (exempt) credited the proceeds, buying
  back with them was exempt too, and so on: sell-and-buy-back could loop with
  no limit, each round paying the fee and up to `MAX_SLIPPAGE_BPS`. **Fix:**
  `_check` returns the exempt part of the input, and `_trade` credits only
  the counted share of the output, `amountOut × (amountIn − exempt) /
  amountIn`. Regression test: "what an exempt sale brings in is not exempt
  itself" in `contracts/test/breakIt.test.js`. Please review the fix and the
  rest of the exemption logic again.
- **Safe Module:** the whole contract (81 lines), never audited.
- **Yield Router:** the pre-audit fixes listed in section 1 (the best-venue
  rule for deposits, the fee-free redeposit window, the Aave health-factor
  floor), and the accepted rate-manipulation risk in YIELD_ROUTER.md.
- **Meme Router:** the whole contract, new.
- **Solana order program:** the whole program, new (SOLANA_ORDERS.md), if
  the same firm covers Solana.
- **Below the bar on the Trade Router, for your view:** `setLimits` resets
  what was spent this period (only the user can call it); for a token that
  taxes transfers, the price is checked before the tax.

### Second AI audit (Fable 5.2, 15 November 2026)

An independent AI review of all five contracts, one reviewer each, run before
this engagement. Every finding came with a proof test; every proof was re-run
and reproduced, and each fixed one is kept as a regression test that now
asserts the safe behaviour. No Critical or High finding. Please review each fix.

| Contract | Finding | What changed | Regression test |
|---|---|---|---|
| Trade Router | **M-1** A sell exemption (`boughtByRouter`) never expired: it survived `revoke()` and new limits, and later covered tokens the user got elsewhere (about $30k sold in one trade under a $10/day limit) | Credits belong to a grant: `setLimits()` and `revoke()` move the account's `creditEpoch` on, and older credits read as zero | `TradeRouterAudit.t.sol` M1 tests |
| | L-1 Real volume is up to 2× the period limit (4× across a window boundary): counted buys plus exempt sales of them | Disclosed on the permission screen and in SESSION_KEYS.md | `test_L1_volumeBoundIsAsDisclosed` |
| | L-2 A trade worth under 1e-8 USD had no price floor | Zero-size and zero-value trades refused | `test_L2_dustAndZeroTradesAreRefused` |
| | L-3 Chainlink min/max answers unchecked | Deploy pre-flight requires each price ≥ 10× the aggregator's minimum and ≥ 3% under its maximum. **Known bound:** the USDC and USDT feeds cap at $1.05, live only if the coin trades above $1.05 | `routerDeploy.test.js` (real feeds) |
| | I-2, I-3 A token could be a venue; duplicate tokens; no onchain cap on a grant | Constructor refuses both; `validUntil` at most 30 days (`MAX_GRANT`) | I2, I3 tests |
| Yield Router | **M-1** A flash loan defeats the "pays more" rule within a transaction: a hacked key churned a user daily, 0.1% each time | The same money pays at most once per fee period (`FEE_COOLDOWN`, the user's break-even: `FEE_BPS / MIN_GAIN_BPS` of a year, 36.5 days): moves of money that has paid are free in the period (refined by the re-review below) | `yieldRouterAudit.test.js` M-1; `invariant_eachUnitPaysOncePerPeriod` |
| | L-1 Rates were only compared before a move or deposit | Both checked again after it (on Base's real markets this alone refuses the flash churn) | as above |
| | L-2 The health-factor floor blocked exits that don't lower health | Refuses only a withdrawal that lowers the health factor and ends under 1.5 | L-2 test |
| | L-3 One 1-unit withdrawal made every deposit fee-free for a week | A fee-free credit per account and asset, up to what was withdrawn (now only paid money: re-review L2) | re-review L1/L2 test; `invariant_creditOnlyFromPaidMoney` |
| | L-5 The rate rule favours a venue in distress (100% utilisation) | No deposit or move into a venue paying over `MAX_RATE` (25% APR) | yieldRouter.test.js |
| | I-1, I-3 Venues not validated; one reverting rate source blocked deposits | Constructor checks aToken / Comet base token / vault asset; a failing rate source is skipped | fork tests |
| Meme Router | **M-1** A token listed as a venue would let anyone drain approvals of it (anyone can fill their own order) | Constructor refuses the wrapped native and base assets as venues; orders can't trade a venue. Deployment requirement: no venue may answer as a token (pre-flight, when the deploy script is written) | `memeRouterAudit.test.js` M-1 |
| | M-2 A hacked executor can fill a floor order at its floor while the market is higher | The documented worst case; stated plainly in MEME_ROUTER.md | M-2 test checks the bound |
| | L-1 Orders signed by an account that later gains code (EIP-7702) stopped being fillable | ECDSA first, then EIP-1271 | L-1 test |
| | L-2 Native coin a venue handed back stayed in the router | Sent to the account (wrapped where possible) | L-2 test |
| | L-3 No executor-side minimum | `Fill.minAmountOut`, checked with the user's | L-3 test |
| | Info: the input fee was charged on input the venue didn't use | Charged on what was used | memeRouter.test.js |
| Safe Module | L-2 A Safe with the module set as its fallback handler let outsiders set its session | `setSession` and `revoke` accept only exact calldata (a forwarded call carries 20 extra bytes) | `safeModuleAudit.test.js` L-2 (real Safe 1.4.1) |
| | L-1 Disabling the module doesn't end a session; re-enabling revives it | Documented: `revoke()` is the stop, not disabling alone (the app's stop button must send it: re-review N-3) | L-1 test |
| | I-1 No fast stop: RektBull couldn't drop a session, one owner couldn't stop it | `renounce(safe)` by the session key; `revokeFor(safe)` by any single owner (both only end sessions) | I-1 test |
| Solana orders | **M-1** One shared `transit` let anyone (naming themselves executor) use its signature for any venue instruction, e.g. closing its pump.fun volume account and taking the rent, which the next user's buy then paid again | Each owner has their own transit (`["transit", owner]`); a fill may only call the venue's swap instructions (`is_swap`) | orders.rs, pump_fun.rs (real pump.fun) |
| | L-1 Signer flags were forwarded to the venue | Only transit signs a venue call; a fill the owner signed is refused | orders.rs |
| | L-2 The input fee was charged on input the venue didn't use | Charged on what was used (`fee_on_used`) | orders.rs, venues.rs |

### Re-review of the fixes (Fable 5.2, 16 November 2026)

The same AI reviewer, one per contract, reviewing only what changed after the
second AI audit: the fixes above and the break-even cooldown. All the earlier
fixes held; nothing Critical, High or Medium. Every proof was re-run and
reproduced before anything was changed; each fix has a regression test.

| Contract | Finding | What changed | Regression test |
|---|---|---|---|
| Yield Router | L1 A dust deposit (fee: 1 unit) made every later deposit and move fee-free for the whole period | Fees are on money: within a period the router keeps the account's paid money in positions (`paidHeld`). A deposit pays on new money, a move is free up to `paidHeld` and pays on the rest, and an amount whose fee rounds to 0 counts as nothing | `yieldRouterAudit.test.js` re-review L1/L2; `invariant_eachUnitPaysOncePerPeriod` |
| | L2 The redeposit credit could be inflated by withdrawing money supplied to the venue directly, and never expired if topped up | A withdrawal only turns the paid money it takes out into credit, and the credit ends with the fee period | as above; `invariant_creditOnlyFromPaidMoney` |
| | L3 One venue above `MAX_RATE` (in distress) blocked every deposit of its asset | `_bestRate` skips rates above `MAX_RATE` | `test_distressedVenueDoesNotBlockDeposits` |
| | L4 No floor on `FEE_COOLDOWN`: other settings could shorten it below a permission, or make every move impossible | Constructor refuses a cooldown under 30 days (unless the fee is 0) and a minimum gain of 25% or more; `setLimits` at most 30 days ahead (`MAX_GRANT`) | `test_settingsThatBreakTheFeeBoundCantBeDeployed` |
| Trade Router | N-1 The "twice the limit in a day" disclosure was wrong: credits build across days, so one sale can be far over the daily and per-trade limits | Disclosure corrected (permission screen, SESSION_KEYS.md): over a grant, up to twice (days × daily limit); one sale of everything bought can exceed both limits | (wording) |
| | N-2 Moving bought tokens out doesn't reduce what may be sold exempt within the grant | Accepted and documented: bounded by the grant's buys, each sale still price-checked | (wording) |
| | N-3 Renewing or changing limits wiped the sell credits, so a stop-loss could take days | `setLimits` moves the epoch on only when the grant had ended (or was revoked); an early renewal keeps the credits | `test_M1_renewalKeepsCreditsANewGrantEndsThem` |
| | N-4 A full 30 days could fail on a clock ahead of the chain | The app asks for 10 minutes less (also for Yield Router limits) | yield.e2e.js |
| | I-2 (refined) The spend-permission manager as a venue would let anyone spend another wallet's permission | Constructor refuses it as a venue | `test_spendPermissionManagerIsNotAVenue` |
| Meme Router | N-1 Refusing orders that trade a venue didn't protect approvals of a token wrongly listed as a venue | Constructor refuses any venue that answers `totalSupply()` or `balanceOf()` (0x's AllowanceHolder and four.meme's TokenManager2 revert both, checked onchain). A venue with a pull-from-`from` function (Permit2-style) can't be told apart by a call: the venue list must be reviewed for that before deployment | `memeRouterAudit.test.js` M-1 |
| | N-2 With no wrapped native, one wei sent to the router could block fills for wallets refusing native coin | A wrapped native is required | re-review N-2 test |
| | N-3, N-4, N-5 (Info) Unused input still consumes the order; native refunds on non-unwrap fills pay the fee; docs out of date | Documented in MEME_ROUTER.md | (docs) |
| Safe Module | N-1 `revokeFor` forwarded through a nested owner-Safe's fallback let an outsider end another Safe's session | `revokeFor` and `renounce` take exact calldata | `safeModuleReReview.test.js` N-1 (real Safe 1.4.1) |
| | N-2 `renounce` is one transaction per Safe, and a pending signed `setSession` could revive a key | `retire()`: the session key gives up every session at once, for good; a retired key can't trade or be named again | N-2 test |
| | N-3 The documented stop (revoke with disabling) isn't in the app yet | NatSpec no longer claims it; the app's stop button must send `revoke()` (Stage 4, trade service integration) | (procedure) |
| | N-4 `SessionRevoked` was emitted with no session | Emitted only when a session ended | N-4 test |
| Solana orders | N-1 Per-owner transit stranded rent: users' volume accounts (about 0.0037 SOL) and the executor's token accounts (about 0.002 SOL per user and coin) | A fill closes transit's emptied token accounts, rent back to the executor who opened them (left open if Token-2022 withheld fees prevent closing); new `close_volume_account`, signed by the owner, closes their transit's pump.fun or PumpSwap volume account and returns its rent to them (only that instruction, never from a fill) | orders.rs; pump_fun.rs `the_owner_gets_their_volume_accounts_rent_back` (real pump.fun) |
| | N-2 The input fee could silently be 0 when the venue used everything | A fill that leaves no room for the fee is refused (`NoRoomForFee`) | `a_fill_that_leaves_no_room_for_the_fee_is_refused` |
| | N-3, N-4, N-5 (Info) The swap allowlist pins third-party instruction names; other transit token accounts aren't checked for leftovers; tests and docs | Documented in SOLANA_ORDERS.md; `fee_on_used` unit test added | lib.rs tests |

Also new since the first list above: fills need address lookup tables (a
PumpSwap fill is 1,317 bytes without one), and each user pays the rent of
pump.fun's and PumpSwap's volume accounts for their own transit (about 0.0018
SOL each, once) in their first order transaction (SOLANA_ORDERS.md).

`contracts/config/<chain>.json` lists the Trade Router and the Safe Module
under `awaitingAudit`, so the deploy pre-flight refuses both until the new
audit's commit replaces `auditedCommit` and the entries are removed.

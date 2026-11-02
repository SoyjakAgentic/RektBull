# RektBull: audit brief

*For the external security audit (milestone 0b in [SESSION_KEYS.md](SESSION_KEYS.md)).
Nothing here may hold real funds until this audit is done and every finding is
fixed or explicitly accepted.*

## 1. What to audit

| File | nSLOC | Lines |
|---|---|---|
| `contracts/contracts/RektBullTradeRouter.sol` | 227 | 327 |
| `contracts/contracts/RektBullSafeModule.sol` | 46 | 81 |
| **Total** | **273** | |

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
| G5 | Every trade fits the account's own limits: per-trade USD, per-period USD, expiry. Selling up to what this router bought for the account is exempt; everything else counts | `_check`, `_spend` |
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

## 6. Planned mainnet deployment (Base), for review

Every address below was checked onchain on Base mainnet on 2026-11-02.
Re-check every one, and each feed's heartbeat, at deployment.

| Parameter | Value |
|---|---|
| `feeBps` | 100 (1%) |
| `maxSlippageBps` | 200 (2%) |
| `sequencerUptimeFeed` | `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` (L2 Sequencer Uptime Status Feed) |
| `spendPermissionManager` | `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` (Coinbase) |
| venues | `0x0000000000001fF3684f28c67538d4D072C22734` (0x AllowanceHolder) |
| USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | feed `0x7e860098F58bBFC8648a4311b374B1D669a2bc6B` (USDC / USD) |
| WETH `0x4200000000000000000000000000000000000006` | feed `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` (ETH / USD) |
| cbBTC | feed `0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D` (cbBTC / USD); token address to confirm |
| `maxAges` | Each feed's published heartbeat plus a margin. USDC/USD had last updated 16 hours earlier when checked, which fits a 24-hour heartbeat; ETH/USD was minutes old. **Confirm on data.chain.link.** |
| `feeWallet` | A Safe controlled by RektBull's owners; never a hot key |

The deployment is to be made from a hardware wallet with an audited script.
After deploying, verify the source on Basescan and compare the bytecode with
the audited commit.

## 7. Practicalities

- **Size:** 273 nSLOC. Small, but security-critical and integration-heavy.
- **Ask firms for:** a fixed quote, the timeline, one fix-review round, and a
  public report.
- **Shortlist:** firms that have audited delegation/session-key or DEX-router
  code. Ask each for comparable past reports.
- **Contact:** the repository owner (SoyjakAgentic).

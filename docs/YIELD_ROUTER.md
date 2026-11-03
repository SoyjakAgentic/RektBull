# Automatic yield rebalancing: the Yield Router

*Status: **built and switched off.** The contract
(`contracts/contracts/RektBullYieldRouter.sol`) and its break-it tests
(`contracts/test/yieldRouter.test.js`, 16 tests against the real Aave v3,
Compound v3, Spark sUSDC and MetaMask delegation contracts on a copy of Base
mainnet) pass. The server side (`src/yield/auto.js`) is tested end to end on
the same fork (`test/yield.e2e.js`). Not audited, not deployed.
`YIELD_AUTO_ENABLED` is off, so no permission is accepted and the trade
service does nothing.*

Yield proposals the user signs themselves ([PAYMENTS.md](PAYMENTS.md), `/find`)
work without any of this.

## The promise, and what enforces it

The same design as automatic trading ([SESSION_KEYS.md](SESSION_KEYS.md)):
the user keeps their wallet and gives RektBull's session key a limited,
expiring, revocable MetaMask delegation (EIP-7702 account). Its caveats allow
**only** the Yield Router's `deposit`, `move` and `withdraw`. The router has no
owner, no admin and no upgrade path, and enforces onchain:

| Guarantee | Enforced by | If RektBull is hacked |
|---|---|---|
| Only RektBull's session key can use the permission; it expires (30 days at most); the user can revoke it any time | MetaMask's Redeemer and Timestamp caveats; `disableDelegation` | Revocation is the user's own transaction |
| It can only call the Yield Router's deposit, move and withdraw | AllowedTargets and AllowedMethods caveats | Can't call a token, a venue or anything else |
| Positions are opened only for the user; withdrawals pay only the user | The router: every pull is from the caller, every deposit is on the caller's behalf, every withdrawal is to the caller | **Can't withdraw to itself or anyone else** |
| A move only goes to a venue for the same asset paying at least 1 point more **right now**, read from both venues' contracts | The router (`rateOf`: Aave's liquidity rate, Comet's supply rate, the Sky Savings Rate) | Can't churn money back and forth for fees |
| At most one deposit or move per account a day | The router (`MIN_INTERVAL`) | Worst case in fees: 0.1% of the per-move limit a day |
| Nothing above the user's own per-asset limit, nothing after their expiry | The router (`setLimits`, which only the user can call) | — |
| The fee is at most 0.1% (a constant), paid only to the fixed fee wallet; withdrawals are free | The router (`MAX_FEE_BPS = 10`, `FEE_WALLET` immutable) | Can't charge more |
| The new position is worth what went in, less 0.1% at most | The router (measures the position before and after) | — |
| Getting out is never blocked: withdrawals work after a revoke or expiry, and tokens sent to the router can't jam it | The router | — |

**The remaining risk, stated plainly:** within the user's limits, a hacked
RektBull could deposit idle stablecoins or WETH into one of the listed
venues, or move between them to a better-paying one, once a day, paying
0.1% each time. Every listed venue carries its own smart-contract risk.

## How it runs (when switched on)

1. The user's wallet signs the setup once (`GET /v1/yield/auto/setup`):
   approvals to the router for each asset and position token (the router only
   ever pulls from the caller), Comet's `allow` for the router, and
   `setLimits` (per-asset amounts, at most 30 days).
2. The user signs the delegation; `POST /v1/yield/auto/permissions` checks
   it (exactly four caveats, the router's three methods only, the user's
   signature), checks onchain that the wallet is a MetaMask smart account,
   the router lists exactly RektBull's venues in RektBull's order, and limits
   are set. Safety Pro only.
3. The trade service, each tick: a **critical** risk warning on a venue the
   wallet holds → withdraw all of it to the wallet. Otherwise, when the
   router's interval has passed, the best proposal on that chain (the same
   rules as proposals the user signs), capped at the onchain limit → deposit
   or move. Each is simulated, its signature logged (`key_signatures`), then
   sent; the next tick reads the receipt.

## Before switching it on

1. An audit of `RektBullYieldRouter.sol` (add it to [AUDIT_BRIEF.md](AUDIT_BRIEF.md)'s scope).
2. Deploy it per chain: `contracts/scripts/deployYieldRouter.js`; set
   `YIELD_ROUTERS` (`{"8453": "0x…"}`) on the API and trade services.
3. The trade service deployed with its KMS session key ([DEPLOY.md](DEPLOY.md)).
4. Real-wallet testing with MetaMask's EIP-7702 upgrade and delegation prompt.
5. `YIELD_AUTO_ENABLED=true`, and a page for the setup (not built: the API is).
6. The legal review in [LAUNCH_PLAN.md](LAUNCH_PLAN.md) section 7.

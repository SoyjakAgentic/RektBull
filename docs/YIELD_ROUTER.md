# Automatic yield rebalancing: the Yield Router

*Status: **built and switched off.** The contract
(`contracts/contracts/RektBullYieldRouter.sol`) and its break-it tests
(`contracts/test/yieldRouter.test.js`, 18 tests against the real Aave v3,
Compound v3, Spark sUSDC and MetaMask delegation contracts on a copy of Base
mainnet) pass. The server side (`src/yield/auto.js`) is tested end to end on
the same fork (`test/yield.e2e.js`). Audited in November 2026 (the owner
reports); the pre-audit fixes below came after, so it is re-audited with the
other contracts before deployment (AUDIT_BRIEF.md section 8). Not deployed.
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
| A move only goes to a venue for the same asset paying at least 1 point more, read from both venues' contracts before and again after the move, and never to one paying over 25% APR (a venue in distress shows the highest rate) | The router (`rateOf`: Aave's liquidity rate, Comet's supply rate, the Sky Savings Rate; `MAX_RATE`) | Can't move money to a worse venue as rates stand; a flash loan can still push rates within a transaction (see the fee cooldown) |
| At most one fee per account and asset per 7 days, however many deposits and moves | The router (`FEE_COOLDOWN`) | **Churning can cost at most 0.1% a week per asset** (about 0.4-0.5% over a 30-day permission) |
| A deposit only goes to the best-paying venue for the asset, or one within 1 point of it | The router (`NotBestVenue`) | Can't stand in for a move the rule above refuses, by withdrawing and depositing |
| Putting back what was withdrawn through the router, within 7 days and up to the same amount of that asset, pays no fee | The router (`REDEPOSIT_WINDOW`, a credit per asset) | Withdraw + deposit can't earn a fee a move wouldn't |
| A withdrawal from Aave that lowers the health factor of a user who borrows there can't leave it under 1.5; one that doesn't lower it (the position backs nothing) always goes through | The router (`MIN_HEALTH_FACTOR`, read from Aave before and after the withdrawal) | Can't push a borrowing user toward liquidation by taking out their collateral; the automatic exit isn't blocked by it |
| At most one deposit or move per account a day | The router (`MIN_INTERVAL`) | Worst case in fees: 0.1% of the per-move limit a day |
| Nothing above the user's own per-asset limit, nothing after their expiry | The router (`setLimits`, which only the user can call) | — |
| The fee is at most 0.1% (a constant), paid only to the fixed fee wallet; withdrawals are free | The router (`MAX_FEE_BPS = 10`, `FEE_WALLET` immutable) | Can't charge more |
| The new position is worth what went in, less 0.1% at most | The router (measures the position before and after) | — |
| Getting out is never blocked: withdrawals work after a revoke or expiry, and tokens sent to the router can't jam it | The router | — |

**The remaining risk, stated plainly:** within the user's limits, a hacked
RektBull could deposit idle stablecoins or WETH into one of the listed
venues, or move between them to a better-paying one, once a day, paying
0.1% each time. Every listed venue carries its own smart-contract risk.

**Rates read in the same transaction can be pushed, so the fee is capped
instead.** The router reads each venue's rate at the moment of the call.
Someone with a large flash loan can briefly change a lending market's rate (by
supplying a lot in the same transaction) so that a venue looks better than it
is. The second AI audit (15 November 2026) showed a hacked key doing this
every day on a copy of Base, 0.1% each time. The fix: at most one fee per
account and asset per 7 days (`FEE_COOLDOWN`), so churning can cost at most
0.1% a week per asset, about 0.4-0.5% over a 30-day permission, whatever the
rates do. The rates are also checked again after the move; on Base's real
markets that alone refused every leg of the same attack, but it depends on the
markets, so the cooldown is the bound.

**Below the bar, noted for the auditor:** the rate rule compares rates before
the move (a large move lowers the rate it lands in); the exit side of a move
isn't measured separately (the new position is); a little aToken dust can stay
behind after a full Aave withdrawal; signing in on one chain counts for the
others; and `MIN_INTERVAL` is set at deployment (one day in RektBull's
deployments), with only a one-hour floor onchain.

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
   or move. A proposal the router would refuse by the venues' own onchain
   rates (a deposit not into the best venue, a move whose gain shows only in
   rewards) is skipped; the user can still sign it themselves. Each is simulated, its signature logged (`key_signatures`), then
   sent; the next tick reads the receipt.

## Before switching it on

1. The re-audit of `RektBullYieldRouter.sol` with the changes since November 2026 ([AUDIT_BRIEF.md](AUDIT_BRIEF.md) section 8).
2. Deploy it per chain: `contracts/scripts/deployYieldRouter.js`; set
   `YIELD_ROUTERS` (`{"8453": "0x…"}`) on the API and trade services.
3. The trade service deployed with its KMS session key ([DEPLOY.md](DEPLOY.md)).
4. Real-wallet testing with MetaMask's EIP-7702 upgrade and delegation prompt.
5. `YIELD_AUTO_ENABLED=true`, and a page for the setup (not built: the API is).
6. The legal review in [LAUNCH_PLAN.md](LAUNCH_PLAN.md) section 7.

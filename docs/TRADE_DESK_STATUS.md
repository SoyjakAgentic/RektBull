# Trade desk: where we stopped

*Paused on 2026-11-02 so the Safety desk could catch up; **switched back on
for launch on 2026-11-04**. Trades the user signs open at launch on Base;
automatic trading opens once the Trade Router is deployed on Base
([LAUNCH_PLAN.md](LAUNCH_PLAN.md) sections 0 and 8). Design:
[SESSION_KEYS.md](SESSION_KEYS.md).*

## Done

| Milestone | What | Where |
|---|---|---|
| 0 | Trade Router: no admin, fee ≤ 1% to a fixed wallet, Chainlink price bound, per-account USD limits, sell exemption. Live on Base Sepolia | `contracts/contracts/RektBullTradeRouter.sol`, `contracts/deployments/base-sepolia.json` |
| 1 | Approve-each trading on Base for any EVM wallet; KMS signer; permissions registry; trade service; `/trade` page with limits | `src/trade/`, `public/trade.*` |
| 2 | Automatic trading for MetaMask (EIP-7702 + delegation), positions and exits (take-profit / stop-loss), Soyjak check parity | `src/trade/autonomous.js`, `exits.js`, `test/soyjakParity.test.js` |
| 3 | Safe (RektBull Safe Module) and Coinbase Smart Wallet (spend permission to the router) | `contracts/contracts/RektBullSafeModule.sol`, `src/trade/permissions.js` |
| — | Audit brief and real-wallet checklist | [AUDIT_BRIEF.md](AUDIT_BRIEF.md), [REAL_WALLET_TESTING.md](REAL_WALLET_TESTING.md) |
| — | Sign-in for Coinbase wallets not deployed yet (EIP-6492) | PR #8, `src/auth/erc6492.js` |
| Stage 1 (Virtuals) | Virtuals' current launchpad, BondingV5 with FRouterV3: tokens bought and sold on its curve, its anti-sniper tax and "Project 60 days" drain risk read from its contracts and shown before a buy; the old Bonding kept for selling only (docs/LAUNCHES.md) | `src/services/launchpads.js`, `src/trade/rules.js`, `src/trade/calls.js`, `contracts/scripts/curveCheck.js` |
| Stage 1d | Protected sending on `/trade`: a speed setting for trades the user signs (Standard leaves the fee to the wallet; Fast and Fastest offer the 75th and 95th percentile priority fee of the chain's last 20 blocks, never 0, each step sent with it; none on Arbitrum, which orders by arrival), and one-click "add protected network": Flashbots Protect on Ethereum, PancakeSwap MEV Guard or 48 Club on BNB Chain (48 Club's own check shows when the wallet uses it), each with its caveats from its documentation; Base and Arbitrum need none (no public mempool). Migration 024 | `src/trade/fees.js`, `public/trade.js` |
| Stage 1c | The live launch feed on `/launches`: new launches, nearest to graduating and just graduated, read from Clanker's, Zora's, Virtuals' and four.meme's own contract events every 10 seconds while the page is open; new ones highlighted as they arrive; each card with its flags, the token page and a checked buy (docs/LAUNCHES.md) | `src/services/liveLaunches.js`, `public/launches.js` |
| Stage 1b | The token page (`/token?chain=&token=`, not indexed): price tiles and a candle chart (1 min, 5 min, 1 hour, 1 day; the short ones redrawn while in view) drawn on the page from GeckoTerminal's figures (no third-party script or frame), live trades refreshed every 15 s while in view, top holders with the pool, lockers, burn addresses and the creator marked, what the creator holds now (read from the chain), the launchpad and how close its curve is to graduating, GoPlus's flags, and the project's links each checked against GoPlus's phishing list (a listed one is shown, not linked). Buy buttons open the Trade desk with the amount set. Linked from Launches and from the Trade page | `src/services/tokenPage.js`, `public/token.js` |
| Stage 1a | One click (catching up with Axiom, stage 1): the checks run as soon as a token is picked (`POST /v1/trading/preview`, stores nothing); a click within 30 s sends the checked trade to the wallet in one step (`POST /v1/trading/trades`), every check run again on a fresh price, refused if the price is now past the preview's worst case; the token check, bundle check, firm quote and sale back run at the same time; buy and sell buttons each user sets; each trade records how long the click took to reach the wallet (`plan.timing`). Migration 023 | `src/trade/proposals.js`, `src/trade/rules.js`, `public/trade.js` |

Tests: 53 contract tests (fork of Base Sepolia, real MetaMask, Safe and
Coinbase contracts), the end-to-end test of all three wallets
(`test/autonomous.e2e.js`), the browser test (`test/browser/tradePage.js`).
All green in CI when we stopped.

## Blocked on people, not code (do these before any more trade-desk code)

1. **Real-wallet testing.** Go through [REAL_WALLET_TESTING.md](REAL_WALLET_TESTING.md)
   with MetaMask, Safe and Coinbase. Two open questions only this answers:
   - Does Coinbase let a website add the Spend Permission Manager as an owner
     (step 4.3)? If not, the Coinbase path needs Coinbase's own permission screen.
   - How MetaMask actually shows the delegation signature (step 2.7).
2. ✅ **The audit** (milestone 0b): the owner reports the Trade Router
   passed (November 2026). The Yield Router's audit is next; both are then
   deployed together, guided.
3. **Google Cloud KMS.** The KMS signer has only run against a stand-in.
   Create the key ring and key, give only the trade service's account
   signing rights, and sign one Base Sepolia transaction with it.
4. **One small real approve-each trade on Base mainnet** (checklist section 5).
   This path doesn't need the router or the audit.
5. **The mainnet deployment** itself, from the owner's hardware wallet:
   [ROUTER_DEPLOYMENT.md](ROUTER_DEPLOYMENT.md). Everything for it is ready.

## Not done yet (code)

| Item | Notes |
|---|---|
| Mainnet router deployment | ✅ **Prepared** for Base (2026-11-08), Ethereum and Arbitrum (2026-11-11): parameters confirmed onchain, a hardware-wallet deploy script with pre-flight checks, a verify script, rehearsed on a fork of each chain in CI. The owner runs it: [ROUTER_DEPLOYMENT.md](ROUTER_DEPLOYMENT.md) |
| Verify the testnet contracts on Basescan | Not done; harmless, nice for testers |
| ✅ Milestone 4: Ethereum and Arbitrum | **Built** (2026-11-11): `contracts/config/ethereum.json` and `arbitrum.json` (tokens, feeds and heartbeats confirmed onchain and against Chainlink's directory; no sequencer on Ethereum), one deploy script for all three chains (`deploy:<chain>`), rehearsed on a fork of each in CI; automatic trades on Ethereum go through Flashbots Protect, one in flight at a time; a buy must cover the gas RektBull pays; trades the user signs on all three chains; the Trade page picks the network. Deploying each router is the owner's step: [ROUTER_DEPLOYMENT.md](ROUTER_DEPLOYMENT.md) |
| Milestone 5: Solana with Phantom | Squads Smart Account or Swig; needs a devnet proof first (SESSION_KEYS section 3) |
| Phantom (EVM side) for automatic trading | Approve-each works; automatic depends on Phantom supporting EIP-7702 delegations |
| ✅ Share the wallet code between pages | Done: `/trade` uses `public/common.js` and the shared header |
| ✅ Automatic trading's network from settings | Done: `/trade` offers every network in `AUTO_TRADING_NETWORKS` (Base first), the test network when there's none on mainnet, and says it isn't open when there's none at all |

## Known issues

- `zod` inside Hardhat 3 has an audit finding with no fixed release (it only
  validates our own config). `uuid` is pinned with an override in
  `contracts/package.json`.
- The Base Sepolia test price feeds never update; the test router accepts
  prices up to a year old. Mainnet uses real feeds with their heartbeats.
- Docker image build wasn't fully verified here (Docker Hub rate limit).

## How to pick it back up

1. Read this file, then SESSION_KEYS.md section 7.
2. Run `npm test`, `cd contracts && npm test`, and
   `TEST_DATABASE_URL=… node --test test/autonomous.e2e.js`. If the Base
   Sepolia fork tests fail on stale feeds, see `TEST_FEED_MAX_AGE` in
   `contracts/scripts/deploy.js`.
3. Start with whichever of "Blocked on people" has been done; their results
   decide what code comes next.

# Trade desk: where we stopped

*Paused on 2026-11-02 so the Safety desk (the paid services in
[SCOPE.md](SCOPE.md)) can catch up. This is the handoff note for picking the
trade desk back up. Design: [SESSION_KEYS.md](SESSION_KEYS.md).*

## Done

| Milestone | What | Where |
|---|---|---|
| 0 | Trade Router: no admin, fee ≤ 1% to a fixed wallet, Chainlink price bound, per-account USD limits, sell exemption. Live on Base Sepolia | `contracts/contracts/RektBullTradeRouter.sol`, `contracts/deployments/base-sepolia.json` |
| 1 | Approve-each trading on Base for any EVM wallet; KMS signer; permissions registry; trade service; `/trade` page with limits | `src/trade/`, `public/trade.*` |
| 2 | Automatic trading for MetaMask (EIP-7702 + delegation), positions and exits (take-profit / stop-loss), Soyjak check parity | `src/trade/autonomous.js`, `exits.js`, `test/soyjakParity.test.js` |
| 3 | Safe (RektBull Safe Module) and Coinbase Smart Wallet (spend permission to the router) | `contracts/contracts/RektBullSafeModule.sol`, `src/trade/permissions.js` |
| — | Audit brief and real-wallet checklist | [AUDIT_BRIEF.md](AUDIT_BRIEF.md), [REAL_WALLET_TESTING.md](REAL_WALLET_TESTING.md) |
| — | Sign-in for Coinbase wallets not deployed yet (EIP-6492) | PR #8, `src/auth/erc6492.js` |

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
2. **The audit** (milestone 0b). Send [AUDIT_BRIEF.md](AUDIT_BRIEF.md) to firms
   for quotes. No mainnet router before every finding is fixed.
3. **Google Cloud KMS.** The KMS signer has only run against a stand-in.
   Create the key ring and key, give only the trade service's account
   signing rights, and sign one Base Sepolia transaction with it.
4. **One small real approve-each trade on Base mainnet** (checklist section 5).
   This path doesn't need the router or the audit.

## Not done yet (code)

| Item | Notes |
|---|---|
| Mainnet router deployment | After the audit. From a hardware wallet; parameters in AUDIT_BRIEF section 6 (still to confirm: cbBTC's token address and each feed's heartbeat). Then verify source on Basescan |
| Verify the testnet contracts on Basescan | Not done; harmless, nice for testers |
| Milestone 4: Ethereum and Arbitrum | Router per chain with that chain's feeds (no sequencer feed on Ethereum); Flashbots Protect for sends on Ethereum; `src/trade/networks.js` entries |
| Milestone 5: Solana with Phantom | Squads Smart Account or Swig; needs a devnet proof first (SESSION_KEYS section 3) |
| Phantom (EVM side) for automatic trading | Approve-each works; automatic depends on Phantom supporting EIP-7702 delegations |
| Share the wallet code between pages | `public/trade.js` has its own connect and sign-in; the Safety pages use `public/common.js`. Move `/trade` onto `common.js` when next touching it |

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

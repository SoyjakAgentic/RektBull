# Moving crypto services from soyjak-agentic

RektBull works on its own first. Nothing in soyjak-agentic changes until each
piece below is rebuilt and tested here; then it is switched over and removed
from Soyjak, one piece at a time, each as a separate, confirmed step.

## Already ported (copied and adapted, not moved)

| soyjak-agentic | RektBull |
|---|---|
| `backend/src/services/tokenRisk.js` | `src/services/tokenRisk.js` (providers swapped; Robinhood Chain not yet) |
| `backend/src/services/etherscanApi.js` | `src/providers/explorer.js` (adds Etherscan → Blockscout fallback) |
| `backend/src/services/x402Facilitator.js` | `src/payments/facilitator.js` |
| `backend/src/services/depositAddress.js` (EVM part) | `src/payments/depositAddress.js` |
| `backend/src/services/tokenRegistry.js` (stablecoins) | `src/payments/stablecoins.js` |
| `backend/src/services/cryptoWatcher.js` (idea) | `src/payments/watcher.js` (rewritten: credits per deposit, reorg check) |

## Candidates to move next

| Area | soyjak-agentic files | Fits RektBull? |
|---|---|---|
| Crypto agent pages | `ai-airdrop-eligibility-claim-agent.html`, `ai-dao-governance-agent.html`, `ai-defi-yield-comparison-agent.html`, `ai-smart-contract-audit.html`, `ai-whale-wallet-tracker.html`, `due-diligence.html`, `crypto.html` | Yes, rebuilt as RektBull pages |
| Airdrop checks | `airdropClaimCheck.js` | Yes |
| Governance | `governorReader.js` | Yes |
| Prices and NFT data | `tokenPrice.js`, `nftMarket.js`, `cryptoPricing.js` | Yes |
| Yield data and risk | `yieldRates.js`, `yieldRiskRules.js`, `yieldRiskWatcher.js` | Yes (read-only data and alerts) |
| Wallet safety and Wallet Guardian | `walletSafety.js`, `walletGuardian.js`, `walletGuardianRules.js` | Yes (read-only: holds no key, signs nothing) |
| Solana | `solanaWatcher.js`, `solanaBalancesAt.js`, Solana deposit pool | Later, with Solana payments |
| x402 extras | `x402Pricing.js`, `x402Eligibility.js`, `x402AnomalyTracking.js` | Review; RektBull's pricing lives in `payments/catalog.js` |

## The agents themselves

Each of Soyjak's 23 crypto and social agents, and what to do with it, is in
[AI_AGENTS.md](AI_AGENTS.md). Seven are already RektBull desks. The proposed
ports are the Contract Audit Agent and the meme-launch safety squad, plus two
new community agents built from RektBull's checks.

## Custody: decided, session keys

RektBull **never holds user funds or keys**. Automatic trading is rebuilt on
session keys ([SESSION_KEYS.md](SESSION_KEYS.md)): the user's own wallet grants
a limited, revocable permission. Soyjak's trading rules and positions code
is ported; its custodial wallets are not needed. These parts of
soyjak-agentic hold keys or move funds on users' behalf, so they do **not**
move as they are:

- `walletCustody.js`, `userWalletProvisioning.js`, `walletWithdrawals.js`
- `swapTrading.js`, `swapRules.js`, `swapContext.js`, `tradePositions.js`
- `defiExecution.js`, `defiCalls.js`, `depositSweeper.js`, `depositSweepPolicies.js`
- `coinbaseAgenticWallet.js` (agent wallets that pay other agents)
- `yieldFee.js`, `yieldRewards.js`

What happens to each: `swapRules.js`, `tradePositions.js` and the trading
caps are ported as the trade service's off-chain checks; `swapTrading.js` is
rewritten to redeem a delegation; `defiCalls.js` comes later as delegations
to lending venues; wallet custody, provisioning and withdrawals aren't needed
(users hold their own wallets). Soyjak's existing custodial wallets stay in
Soyjak.

## Also yours to decide

- **SOYA token** (`soyaLedger.js`, `soyaSales.js`, `routes/soya.js`, `token.html`):
  it's Soyjak's own token. RektBull doesn't use it; it could stay with
  Soyjak, or be accepted as a payment option here later.
- **Users:** Soyjak accounts are email-based; RektBull's are wallets. Existing
  crypto users would sign in again with their wallet. Their Soyjak credits
  and purchases stay in Soyjak unless you want a one-off transfer.

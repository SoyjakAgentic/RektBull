# RektBull: Scope

*Carried over from `DAPPRADAR_INSPIRED_SCOPE.md` in soyjak-agentic, updated
with the decisions since: the RektBull name, crypto-only payments, paid
services, and free data plans first.*

---

## 0. Why this exists

DappRadar [announced its shutdown on 17 November 2025](https://cointelegraph.com/news/dappradar-shut-down-financial-unsustainability),
citing financial unsustainability. It tracked about 18,000 dapps across 93
chains. That leaves an opening, and a lesson: rankings, plus ads, plus a PRO
subscription, plus a token didn't pay for a large platform. Its paying
customers were mostly projects buying promotion, and that money disappears
in a downturn.

RektBull is built the other way round: **free data brings people in, and
paid runs that protect, find or save money pay the bills.**

## 1. Decisions so far

| Decision | Choice |
|---|---|
| Name and domain | **RektBull**, `rektbull.com` (owned). Also register `rektbull.app` and redirect it |
| Tagline | "Don't get rekt." |
| Project | Its own repository, service, database and keys, separate from soyjak-agentic |
| Payments | **Crypto only.** x402 for calls up to about $1; USDT/USDC credit top-ups for everything else; prepaid passes. No card payments |
| Accounts | Sign in with your wallet. Email optional, for alerts |
| Custody | RektBull never holds user funds or keys. Agents prepare transactions, users sign |
| Data | Free provider plans first, with caching, daily limits and fallback |
| AI | Claude, called from one module; the model is a setting |

## 2. Positioning: a radar that acts

1. **Every page comes with an agent.** Rankings, dapp pages and wallet views
   each have an "Ask / Act" panel backed by paid runs.
2. **Safety comes first, not popularity.** Every listing shows a safety score
   next to its activity: audits, admin keys and upgradeability, exploit
   history, and how much of its activity looks fake.
3. **Coverage for 2026.** Less weight on NFT and gaming rankings; new
   sections for onchain AI agents, stablecoins and payments, real-world
   assets, DePIN, prediction markets, a safety hub, governance, and wallet
   reputation.

## 3. Paid services

Rule of thumb: price each service at **10% or less of the money it protects,
finds or saves**, and show that figure in the result.

| Group | Service | Price idea | Status |
|---|---|---|---|
| Protect | **Token quick check** (sellability, taxes, owner powers, holders) | $0.25, 5 free a day | ✅ built |
| Protect | **Token due diligence report** (+ liquidity, age, plain-English report) | $3 | ✅ built |
| Protect | Pre-sign check (simulate a transaction before signing) | $0.25–1 | next |
| Protect | Approval cleanup (find risky token permissions, prepare one revoke) | $5 | next |
| Protect | Position risk monitor (exploits, admin changes, depegs, liquidation) | pass, $9–19 / 30 days | later |
| Find | Airdrop and unclaimed-funds finder (check free, pay to prepare claims) | $5–15 | later |
| Find | Yield proposals (agent proposes, user approves) | pass | later |
| Save | Tax and profit report | $29–99 / year | after paid data |
| Save | Governance assistant | pass | later |
| Business | Sybil filtering for airdrops, team reports, contract monitoring, pre-audit check | $49–5k | after paid data |

**Free:** rankings, safety-score summaries, the airdrop eligibility check, and
a few quick checks a day. Users pay for acting, monitoring, deep reports and
volume.

## 4. How people pay

| Who | How |
|---|---|
| Bots and other AI agents, one-off small calls | **x402**, USDC on Base, no account. Most x402 clients refuse over ~$1 a call by default, so this is the main rail for runs up to $1 |
| People on the site | **Credits**: top up once with USDT/USDC on Ethereum, BNB Chain or Base; each run is deducted |
| Monitors and unlimited use | **Prepaid passes** (30 / 365 days), bought from credits. Nothing renews automatically |
| Businesses | A stablecoin invoice for the quoted amount |

Details: [PAYMENTS.md](PAYMENTS.md).

## 5. Site structure (target)

```
Home
├── Discover        rankings, trending, new launches, categories, chains
├── Agents          onchain AI agents, x402 and MCP services
├── Markets         DeFi/TVL, stablecoins, RWA, prediction markets, tokens
├── Safety          token checks, risk scores, exploit tracker, approval cleanup
├── Opportunities   airdrops, points programs, governance votes
├── Portfolio       wallet tracking with agent alerts and proposals
├── Research        AI-written reports and weekly digests
└── Developers      API, MCP server, x402 pricing
```

## 6. Roadmap

| Phase | Scope |
|---|---|
| **Now (this repo)** | API service; wallet sign-in; credits, USDT/USDC top-ups, passes, x402; token quick check and report; free-plan provider layer; tests and CI |
| **Next** | Website (Safety pages first: token check UI, then approval cleanup and pre-sign check); listing pages for 5 chains; safety score v1; airdrop checker |
| **v1** | Filtered activity (sybil/wash filter), onchain-agents hub, stablecoin and RWA pages, position risk monitor |
| **v2** | Public API, MCP server, DePIN and prediction-market hubs, governance hub, project listing console |
| **v3** | Embeddable widgets, wallet reputation, weekly research digests |

## 7. Open questions

1. **Which crypto features move from soyjak-agentic, and when.** See
   [MIGRATION_FROM_SOYJAK.md](MIGRATION_FROM_SOYJAK.md); the custodial wallet
   and trading code there conflicts with RektBull's no-custody rule.
2. **Smart-contract wallet sign-in** (EIP-1271, e.g. Safe). Plain wallets only for now.
3. **Solana payments.** USDC on Solana (x402 is widely used there) is planned
   but not built; Solana is covered for token checks only.
4. **How open the safety-score method is.** Fully open builds trust, but makes it easier to game.
5. **Legal review** before yield proposals or vote recommendations: in some
   places they may count as investment advice.

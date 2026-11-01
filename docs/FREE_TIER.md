# Running on free data plans

Every external data call goes through `providers/usage.track()`, which counts
calls per provider per UTC day and skips a provider at its limit
(`PROVIDER_DAILY_LIMITS`), warning at 80%. Results are cached (`lib/cache.js`):
token scans 6 hours, market data 5 minutes, AI reports 1 hour.

**Check each provider's current free-plan limits and terms before launch.**
Free plans change (Etherscan changed which chains its free plan covers in
2025), and some restrict commercial use or require attribution.

| Provider | Used for | Key | Fallback |
|---|---|---|---|
| Your RPC (e.g. Alchemy free plan) via `RPC_URLS_<CHAIN>` | Contract reads, deposit watching | Yes | Next listed endpoint, then the public RPC |
| Public RPCs (publicnode, mainnet.base.org, ...) | Same, last resort | No | — |
| Etherscan API V2 | Verified source, ABI, role logs | Free key | Blockscout |
| Blockscout PRO API | Same, for chains Etherscan's free plan won't serve | Free key | — (check marked "not checked") |
| GoPlus | Honeypot, tax, owner-power flags, holders, LP locks | No | Our own checks still run |
| 0x | Buy-then-sell honeypot test, taxes (EVM) | Free key | GoPlus's figures |
| Jupiter | Buy-then-sell test (Solana) | Optional | — |
| DexScreener | Liquidity, volume, price, token age | No | — |
| Anthropic | Report writing | Paid per use | Covered by the report price |

## What's not on free data yet

- **Tax and profit reports:** need full transaction histories and historical
  prices; free plans run out quickly.
- **Sybil filtering and team reports:** need bulk onchain data (e.g. Dune).
- **The position risk monitor at scale:** fine for a few hundred users on
  free plans, then needs paid RPC.

Sell these once paid runs justify paid data, and upgrade providers one at a
time as their limits are reached (`GET /v1/admin/provider-usage` shows which).

## AI cost

At the default model, a report costs a few US cents of AI usage against a $3
price. Quick checks use no AI. To lower cost further, set `REPORT_MODEL` and
`REPORT_EFFORT`; no code change needed.

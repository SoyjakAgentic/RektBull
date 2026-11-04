# Running on free data plans

Every external data call goes through `providers/usage.track()`, which counts
calls per provider per UTC day and skips a provider at its limit
(`PROVIDER_DAILY_LIMITS`), warning at 80%. Results are cached (`lib/cache.js`):
token scans 6 hours, market data 5 minutes, AI reports 1 hour, approval
scans 15 minutes (shared by the free preview and the cleanup; a fresh scan
can be asked for after revoking), GoPlus spender checks 24 hours, Discover's rankings 30 minutes, its token lists 5 minutes and GoPlus's free flags for one token 6 hours (20 a day per visitor, 100 signed in).

**Check each provider's current free-plan limits and terms before launch.**
Free plans change (Etherscan changed which chains its free plan covers in
2025), and some restrict commercial use or require attribution.

| Provider | Used for | Key | Fallback |
|---|---|---|---|
| Your RPC (e.g. Alchemy free plan) via `RPC_URLS_<CHAIN>` | Contract reads, deposit watching, current approvals (batched through Multicall3) | Yes | Next listed endpoint, then the public RPC |
| Public RPCs (publicnode, mainnet.base.org, ...) | Same, last resort | No | — |
| Etherscan API V2 | Verified source, ABI, role logs, approval logs | Free key | Blockscout |
| Blockscout PRO API | Same, for chains Etherscan's free plan won't serve | Free key | The chain's public Blockscout |
| Public Blockscout explorers (eth., base., arbitrum., optimism., polygon.blockscout.com) | Same, last resort; rate-limited | No | — (check marked "not checked") |
| GoPlus | Honeypot, tax, owner-power flags, holders, LP locks; spender and address risk; the approval index, only when the explorer can't give a wallet's whole history (it saves GoPlus's free allowance) | No | Our own checks still run |
| Telegram Bot API | Risk monitor alerts | Bot token (free) | The other channels |
| Resend | Alert emails | Free plan, then pay per email (check current limits) | The other channels |
| Web Push (browsers' own push services) | Browser notifications | VAPID keys (free) | The other channels |
| Your RPC / public RPC: `eth_simulateV1` | Pre-sign simulation (what would leave the wallet) | No | "Not checked: simulation"; the decoded request is still checked |
| openchain signature database | Names of functions the pre-sign check doesn't decode (labels only) | No | The raw selector |
| DefiLlama | Prices for trading and for the value at risk in approval cleanup | No | "Not priced", never guessed |
| 0x | Buy-then-sell honeypot test, taxes (EVM) | Free key | GoPlus's figures |
| Jupiter | Buy-then-sell test (Solana) | Optional | — |
| DexScreener | Liquidity, volume, price, token age | No | — |
| DefiLlama (api.llama.fi) | Discover: protocols and TVL, fees in the last 24 hours, recorded hacks, chain TVL. Cached 30 minutes (hacks 6 hours), so a few calls an hour whatever the traffic | No | "DefiLlama didn't answer"; a missing part (fees, hacks) is listed as not checked |
| DefiLlama stablecoins (stablecoins.llama.fi) and DEX volumes | Markets: each stablecoin's supply, peg mechanism and price; DEX volume and total TVL history. Cached 30 minutes (TVL history 1 hour) | No | The page names the part that didn't answer |
| Merkl (live campaigns) | Opportunities: the top 100 live incentive campaigns per chain by money in them. Cached 15 minutes (about 600 calls a day for six chains, whatever the traffic) | No | A chain that didn't answer is named |
| CoinGecko (keyless public API) | Markets: the 100 largest tokens by market cap. Free plan allows a few calls a minute and asks for attribution ("Data from CoinGecko", linked on the page); cached 10 minutes (about 150 calls a day), one retry after a 429 | No (a free demo key raises the limit) | The page says it didn't answer |
| GeckoTerminal | Discover: trending and newest pools per chain. Free plan about 30 calls a minute; each list cached 5 minutes, one retry after a 429 | No | The page says it didn't answer |
| Anthropic | Report writing | Paid per use | Covered by the report price |

## What a visitor costs (measured)

Responses are gzip-compressed, and pages that only need a wallet to sign in
don't load ethers (514 KB): it's on `/safety` and `/trade` only. A first visit
to Discover is about 164 KB on the wire (fonts included); a visit to another
page after that is about 40 KB. At Cloud Run's list prices that is roughly
$0.00002 for a first visit, mostly bandwidth; the data behind the free pages is
fetched on timers, so it costs the same whatever the traffic.

## A portfolio read's cost

One read is one explorer call per chain (the wallet's token transfers), one
Multicall3 batch per chain for balances, one DefiLlama price call, plus the
yield desk's position read and the approval preview (both shared with their
desks' caches). It's cached 5 minutes per wallet and limited to 5 a day
without signing in, 30 signed in. A slow part (a wallet with thousands of
approvals) is cut off after 25 seconds and named, so the page still answers.

## The risk monitor's cost

Each watched wallet gets one fresh approval scan a day (about 18 explorer
calls and ~15 RPC reads, GoPlus only as the fallback), plus one RPC read per
spender contract (its EIP-1967 implementation) and a few for stablecoin
balances. That is about 550 explorer calls per wallet a month: Etherscan's
free plan (about 100K a day) covers several thousand watched wallets. The
worker checks at most 10 wallets every 5 minutes, so a burst never hits a
provider all at once.

## What's not on free data yet

- **Tax and profit reports:** need full transaction histories and historical
  prices; free plans run out quickly.
- **Sybil filtering and team reports:** need bulk onchain data (e.g. Dune).
- **The position risk monitor at scale:** fine for a few hundred users on
  free plans, then needs paid RPC.

Sell these once paid runs justify paid data, and upgrade providers one at a
time as their limits are reached (`GET /v1/admin/provider-usage` shows which).

## The weekly digest's cost

One Claude call a week (about 1,500 tokens in and 600 out at the default
model: cents a month), plus the cached data the other desks already read.

## AI cost

Every AI call's tokens are recorded per model and day, with an estimated
cost from list prices (`GET /v1/admin/provider-usage`, under `ai`), so the
real cost per report can be read rather than guessed.


At the default model, a report costs a few US cents of AI usage against a $3
price. Quick checks use no AI. To lower cost further, set `REPORT_MODEL` and
`REPORT_EFFORT`; no code change needed.

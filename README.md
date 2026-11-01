# RektBull

**Don't get rekt.** RektBull finds and checks crypto projects, and runs paid
safety agents on them. It is the crypto-only spin-off of Soyjak Agentic and
is built and deployed on its own: its own service, database, keys and
payments.

- **Crypto payments only.** x402 (USDC on Base, per call, no account) for
  small runs; USDT/USDC top-ups into credits for everything else; prepaid
  passes instead of subscriptions. No card payments.
- **Sign in with your wallet.** The wallet is the account; email is optional.
- **Never holds user funds.** Agents prepare transactions, users sign them.
  Deposit addresses come from a public key; their private keys stay offline.
- **Free data plans first.** Every provider call is cached and counted
  against its plan's daily limit, with fallback to the next provider.

## What works today

| Endpoint | What it does |
|---|---|
| `GET /v1/catalog` | Products, prices and how each can be paid for |
| `GET /v1/payment-methods` | x402 and stablecoin top-up options |
| `POST /v1/auth/nonce`, `POST /v1/auth/verify` | Sign in with your wallet (EIP-4361) |
| `GET /v1/me`, `GET /v1/credits` | Account, credits balance and history, active passes |
| `POST /v1/invoices`, `GET /v1/invoices[/:id]` | Top up credits with USDT/USDC on Ethereum, BNB Chain or Base, optionally buying a pass |
| `POST /v1/passes/:product` | Buy a prepaid pass from credits |
| `POST /v1/tokens/quick-check` | Token contract risk scan ($0.25; 5 free a day when signed in) |
| `POST /v1/tokens/report` | Scan + market data + plain-English AI report ($3) |
| `GET /v1/admin/provider-usage` | Calls per data provider per day, against their limits |
| `GET /trade` | The trading page: connect a wallet, sign in, check and sign trades, set automatic-trading limits |
| `POST /v1/trading/proposals`, `…/:id/approve`, `…/:id/submitted` | Approve-each trading on Base: RektBull checks the trade and builds it, the user's wallet signs it |
| `GET/PUT /v1/trading/settings`, `GET /v1/trading/positions`, `GET /v1/trading/limits` | Safety settings, positions from RektBull trades, onchain router limits |
| `POST/GET /v1/trading/permissions` | Register an automatic-trading permission (checked in full before it's stored) |
| `GET /v1/trading/auto/delegation`, `GET /v1/trading/auto/allowances` | The exact permission to sign, and the approvals the router needs |
| `POST/GET /v1/trading/auto/intents` | Automatic trades (Base Sepolia until the audit): simulated, then sent by RektBull's session key through the user's permission |

Token checks cover Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain and
Solana. Example:

```bash
curl -X POST localhost:8080/v1/tokens/quick-check \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"chain":"base","token_address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}'
```

Without a session or payment it answers `402 Payment Required` with every
way to pay, including x402 terms in `accepts`.

## Try it on your own computer (one command)

You need Docker Desktop, a free 0x API key, and a wallet extension (MetaMask,
Coinbase Wallet or Phantom) in your browser.

```bash
git clone https://github.com/SoyjakAgentic/RektBull.git
cd RektBull
git checkout claude/dappradar-website-outline-wdv0qx
cp .env.local.example .env      # then put your 0x key and fee wallet in .env
docker compose up               # first run builds the app: give it a few minutes
```

When the terminal shows `RektBull API listening on 8080`, open
**http://localhost:8080/trade** in the same browser as your wallet. Ctrl+C
stops it; your trade history is kept until `docker compose down -v`.

Trades are real (Base mainnet), signed by your wallet, from your wallet back to
your wallet. Only you can open the page; nothing is put online.

**"This page can't be reached"** means nothing is answering on that computer:
- Is `docker compose up` still running, and did it print `listening on 8080`?
  If it stopped, the lines just before tell you why.
- Open it in a browser **on the same computer** that runs Docker. `localhost`
  on a phone or another machine is that device, not yours.
- Use `http://`, not `https://`.
- Something else on port 8080? Stop it, or change the left number in
  `docker-compose.yml` (`"127.0.0.1:8081:8080"`) and open :8081, setting
  `SIWE_DOMAIN` and `SIWE_URI` to match.

## Run it locally

```bash
cp .env.example .env        # fill in what you have; most of it is optional
npm install
npm run db:migrate          # needs DATABASE_URL (also run automatically on start)
npm run dev                 # SERVICE_ROLE=all: API + deposit watcher
```

With no keys at all, quick checks still run on public RPCs, GoPlus and
DexScreener; the explorer checks (verified source, roles) need a free
Etherscan or Blockscout key, and reports need `ANTHROPIC_API_KEY`.

## Tests

```bash
npm test                                                            # unit tests
TEST_DATABASE_URL=postgres://user:pass@localhost/rektbull_test npm test   # + end-to-end
```

The autonomous end-to-end test (`TEST_DATABASE_URL=… node --test test/autonomous.e2e.js`,
after `cd contracts && npm install && npx hardhat compile`) runs automatic
trading on a local copy of Base Sepolia against MetaMask's real contracts.

The browser test drives the trading page in Chromium with a stand-in wallet
(`TEST_DATABASE_URL=… node test/browser/tradePage.js`); it isn't part of
`npm test`. Contract tests are in `contracts/` (`cd contracts && npm test`).

The end-to-end test drops and recreates the schema in that database, runs a
fake Base node, and covers sign-in, the free allowance, credits, refunds on
failed runs, a USDC top-up through the deposit watcher, a pass bought from
an invoice, and a reorged deposit that must not be credited. CI runs both.

## Layout

```
src/
  server.js            web / worker / all
  app.js               Express app, error handler
  routes/              HTTP endpoints
  auth/siwe.js         Sign in with your wallet
  payments/            catalog, gate (pay for a run), credits, invoices,
                       deposit addresses, watcher, passes, x402, facilitator
  providers/           RPC with fallback, Etherscan/Blockscout, DexScreener,
                       per-provider usage limits
  services/            tokenRisk (ported from Soyjak), dueDiligence
  ai/claude.js         the one place Claude is called
  lib/cache.js         memory + database cache
migrations/            SQL, applied in order
docs/                  scope, payments, free tier, deploy, migration from Soyjak
```

## Docs

- [docs/SCOPE.md](docs/SCOPE.md): what RektBull is, what it covers, roadmap
- [docs/PAYMENTS.md](docs/PAYMENTS.md): how each payment rail works, and the keys it needs
- [docs/FREE_TIER.md](docs/FREE_TIER.md): which free data plans each service runs on
- [docs/SESSION_KEYS.md](docs/SESSION_KEYS.md): automatic trading without custody (design)
- [docs/DEPLOY.md](docs/DEPLOY.md): Cloud Run, secrets, and the domain
- [docs/MIGRATION_FROM_SOYJAK.md](docs/MIGRATION_FROM_SOYJAK.md): which crypto pieces move here from soyjak-agentic, and which don't

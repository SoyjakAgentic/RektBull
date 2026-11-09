# RektBull: launch plan

*Written 2 November 2026, for when we deploy. Nothing here is live yet.
[DEPLOY.md](DEPLOY.md) explains each piece; this is the order to do them in,
who does each step, and how we know it worked.*

## 0. What launches, and what doesn't

**Launch = the Safety desk and the trade desk.** Token quick check and report,
approval cleanup, the pre-sign check, the risk monitor with Telegram, email and
browser alerts, free points, credits, Safety Pro, x402, and the privacy page.
Plus whatever we finish from section 1 before the date.

**The trade desk** was switched back on for launch on 4 November 2026 (the
owner's audit of the Trade Router passed). It opens in two stages:

1. **At launch: trades you sign yourself, on Base** (approve-each). Every
   token is checked first, the user's wallet signs the swap, and 1% goes to
   `SWAP_FEE_WALLET_EVM`. This path needs no router and no KMS key.
2. **Automatic trading, after the Trade Router is deployed on Base**: the
   guided deployment (with the Yield Router, once its audit is done), then the
   KMS key and the trade service. Until then `/trade` says automatic trading
   opens when the router is deployed (section 8 has the steps).

**Not at launch:**

| What | Why | How it stays off |
|---|---|---|
| Automatic trading (stage 2 above) | The Trade Router isn't deployed on Base yet | `AUTO_TRADING_NETWORKS={}`; `rektbull-trade` isn't deployed (`_DEPLOY_TRADE=false` in `cloudbuild.yaml`); no KMS key is made yet |
| Browser extension in the stores | Its listing must point at a live site and privacy page | Section 6, after launch |
| MetaMask Snap | Same, and MetaMask allowlisting needs a live API | Section 6, after launch |
| Listing in the MCP Registry | The registry needs `rektbull.com/mcp` live, and a DNS record proving the domain | Section 6, after launch ([MCP_REGISTRY.md](MCP_REGISTRY.md)) |
| Solana payments | Not built | Solana stays token checks only |

## 1. Before deployment: finish the planned desks

Decided 2 November 2026: the Safety Pro features and the other planned desks
are built before we deploy. Each is its own PR, in this order unless we change it:

1. ✅ **Find money: airdrop and unclaimed-funds finder** (`/find`). The check
   is free; claims carry 5% of what arrives (3% with Safety Pro), as a
   transfer the user signs with the claim. At deploy: `CLAIM_FEE_WALLET_EVM`
   (section 4), and add the live Merkle airdrops worth covering
   (`POST /v1/admin/airdrops`; Merkl rewards need nothing).
2. ✅ **Find money: yield proposals** (`/find`, Safety Pro; 0.1% per move).
   At deploy: `YIELD_FEE_WALLET_EVM` (or it uses the claim fee wallet).
   Needs the legal review in section 7 before it goes live. ✅ Automatic
   rebalancing (the Yield Router and session keys) is built and switched off
   ([YIELD_ROUTER.md](YIELD_ROUTER.md)).
3. ✅ **Save money: governance assistant** (`/governance`). Snapshot votes, and
   on-chain governors (OpenZeppelin Governor and Compound Bravo: Uniswap,
   Compound, ENS, Gitcoin, Hop, Arbitrum, plus any a user adds), with each
   proposal's actions decoded and flagged. Needs the legal
   review in section 7 like yield proposals, although it never recommends a vote.
4. **Site desks** from [SCOPE.md](SCOPE.md) section 5: Home, Discover,
   Markets, Opportunities, Portfolio, Research, Agents, Developers.
   Free data first, each with its "Ask / Act" panel.
   - ✅ **Home** (`/`): one box that says what a pasted address is on each
     chain (wallet, Safe, token, NFT collection, DAO governor, contract) and
     sends it to the desk that checks it; a wallet gets the free checkup from
     every desk at once (approvals, unclaimed rewards, yield, DAO votes), each
     part with its source. Nothing to set at deploy.
   - ✅ **Discover** (`/discover`): dapps ranked by TVL, fees or weekly
     change, each with the hacks, audits, listing age and doubted TVL
     DefiLlama records; categories and chains; trending and new tokens
     (GeckoTerminal) with the warning signs their own trading shows, GoPlus's
     flags on request and the quick check a click away. Free data, cached.
     Nothing to set at deploy; check DefiLlama's and GeckoTerminal's terms
     for commercial use (section 3).
   - ✅ **Markets** (`/markets`): DeFi today (TVL with a 90-day chart, DEX
     volume, fees, stablecoin supply); stablecoins with whether each holds its
     peg, what backs it and whether supply is leaving; real-world assets and
     prediction markets with Discover's safety facts; the largest tokens
     ("Data from CoinGecko", linked, as its free plan asks). Nothing to set at
     deploy; check CoinGecko's terms for commercial use, or get its free demo key.
   - ✅ **Opportunities** (`/opportunities`), the menu item for Find money and
     Governance too: a wallet's own opportunities (unclaimed rewards, better
     yield, DAO votes, with a warning first when apps can still take from
     it); live reward campaigns from Merkl with the protocol's DefiLlama
     record, the action's risk (borrowing, providing liquidity), unverified
     reward tokens and early ends; links to claim, earn and vote. Points
     programs are left out: no reliable free source, and guessing would
     break "every check names its source". Nothing to set at deploy.
   - ✅ **Portfolio** (`/portfolio`): a wallet's tokens and DeFi positions on
     six chains at DefiLlama's prices, by chain; facts on holdings (lookalike
     tokens, links in names, only ever received, stablecoins off peg),
     unpriced tokens kept out of the total with a scam-airdrop warning, and
     approvals at risk. Free, 5 a day without signing in. Nothing to set at
     deploy beyond the Etherscan key already listed.
   - ✅ **Research** (`/research`): the hack tracker (DefiLlama's record:
     totals per period, techniques by amount, newest first, unrecorded
     amounts said so) and the weekly digest, which includes opportunities
     (new and largest reward campaigns with any bad signal, the best USDC
     and USDT supply rates, open DAO votes). The digest's facts are gathered
     from RektBull's own data with their sources and stored. Every Monday
     from 06:00 UTC the worker drafts it: a writer (Claude, told to use
     only the facts, cite each, never predict or recommend), then a
     fact-check (Claude again) that removes any sentence the facts don't
     support, and alerts the owner. **The owner reviews it** on
     `/research#review` (signed in with an `ADMIN_WALLETS` wallet), may
     edit it, and publishes it or skips the week; nothing is shown or
     emailed before that. Published, it carries the byline "Written by
     RektBull Research". With no AI the facts alone can be published.
   - ✅ **Weekly newsletter**: the published digest by email (Resend),
     double opt-in, one-click unsubscribe that deletes the address,
     unconfirmed sign-ups deleted after 7 days, 5 sign-ups a day per IP
     address. Sent by the worker in batches (`NEWSLETTER_PER_TICK`, 50
     every 5 minutes), resumable. **At deploy:** set
     `OPERATOR_POSTAL_ADDRESS` (US law, CAN-SPAM, asks every commercial
     email to carry a postal address; a PO box or registered-agent address
     is fine, and nothing is sent without one). Resend's free plan allows
     100 emails a day and 3,000 a month: move to its paid plan before the
     list nears 100 confirmed subscribers. After the first deploy, draft
     the first digest by hand (the button on the review card, or
     `POST /v1/admin/research/digest`) and publish it so the page isn't
     empty. Migration 014 runs by itself.
   - ✅ **Sponsored posts in the digest**: the owner adds up to two a week to
     a draft on the review card (one above the digest, one below):
     sponsor, headline, up to 400 characters of plain text and an https
     link. They're labelled "Sponsored · <sponsor>" with "A paid placement.
     Not checked or endorsed by RektBull, and not advice.", on the page and
     in the email, kept out of what the writer and fact-check see, and
     fixed once the week is published. The link is checked against GoPlus's
     phishing list when saved (listed or uncheckable: refused) and again on
     every click, through RektBull's redirect, which stops a site listed
     since. Clicks are a count only; the review card shows each post's
     clicks and how many it was emailed to. Migration 015.
     **Policy for the owner** (the code asks you to confirm the first point
     for each post; the rest are yours to keep):
     - No promotion to buy, sell or invest in a cryptoasset (tokens,
       presales, staking or yield products, exchanges' trading offers). In
       the UK those are financial promotions that only an FCA-authorised
       firm may approve, and the EU's MiCA rules cover crypto marketing;
       the newsletter reaches both. Wallets, security tools, hardware
       wallets, developer tools, events and education are the safe kind.
       Ask a lawyer before taking anything closer to investing.
     - No airdrop or claim links, no "connect your wallet" pages: those are
       how drainers work, and a safety product can't carry them.
     - Charge sponsors in crypto only (a NOWPayments invoice or a direct
       USDC transfer to your wallet); RektBull doesn't bill sponsors itself.
     - A skipped week shows no sponsored posts: move them to the next week.
   - ✅ **Developers** (`/developers`): RektBull's **MCP server** at `/mcp`
     (Streamable HTTP, stateless JSON; 16 read-only tools: lookups,
     checkups, approvals preview, portfolio, rewards, DAO votes, token
     flags, rankings, markets, stablecoins, rates, campaigns, hacks, the
     digest, and `paid_services`, which tells an agent how to call the paid
     runs with x402). No tool signs, sends or prepares a transaction. The
     tools use the same daily allowances as the website, per IP or per
     signed-in wallet (`src/payments/freeLimits.js`, now shared by the
     routes). Also the API reference and x402 prices, built from one list
     (`src/developers/api.js`) that also serves `/v1/openapi.json`; a test
     checks every documented endpoint is a real route. Tested with the
     official MCP SDK client. The header menu drops Home (the logo is home)
     and puts Extension and Developers under More, so it stays one row.
     **After launch:** list it in the official MCP Registry (section 6,
     step by step in [MCP_REGISTRY.md](MCP_REGISTRY.md)).
   - ✅ **Agents** (`/agents`): the paid APIs agents call with x402, from
     Coinbase's x402 Bazaar (the 500 busiest of over 100,000 listings,
     cached 6 hours), grouped into services and ranked by different payers
     in 30 days, with the noise (under 5 payers) left out and testnets
     dropped. Signals with their sources: usage that looks generated (about
     one call per payer, judged on the busiest endpoint), few users, no
     calls in 14 days, plain http, and a payment address GoPlus flags
     (shown in red, each address linked to the Home lookup). Prices shown
     only in stablecoins RektBull can read as dollars. Also the onchain
     AI-agent protocols (DefiLlama's "AI Agents", with their record), and
     how to give an agent RektBull safely. Both are MCP tools too
     (`x402_services`, `agent_protocols`). Nothing to set at deploy.
   - ✅ Site-wide with Markets: gzip on every response, and ethers loaded only
     on `/safety` and `/trade` (a first visit went from 762 KB to about 164 KB).
5. Anything that needs paid data (tax report, business services) waits until
   after launch, when there's revenue to pay for it.

When a desk is done, tick it here and add what it needs at deploy time
(settings, secrets, provider accounts) to sections 3 and 4.

## 2. Who does what

| Step | You (owner) | Claude |
|---|---|---|
| Accounts, billing, payment of fees | ✔ every account in section 3 | Lists what's needed and what it costs |
| Wallets that receive money | ✔ make them on a hardware wallet or Safe; give only public addresses / the xpub | Checks the xpub derives the addresses you expect |
| Google Cloud project, database, secrets | ✔ runs the commands (or gives Claude a session with access) | Writes the exact commands; reviews the output |
| DNS for rektbull.com | ✔ adds the records | Gives the records; checks them |
| Deploy | Merges to `main` (the trigger deploys) | Watches the build; fixes failures in a PR |
| Smoke test (section 5) | ✔ the wallet steps (signing, a $5 top-up) | Writes and runs the automated part; reads logs |
| Store and Snap submissions (section 6) | ✔ accounts, payment, submitting | Packages, writes listings and answers, fixes review findings |
| Legal review (section 7) | ✔ hires the lawyer | Prepares the pages and a summary of data flows |

**Never send Claude, or put in any repo, chat or issue:** a seed phrase, a
private key, an xprv, or a KMS key. Secrets go straight into Secret Manager.

## 3. Accounts to open

| Account | For | Cost at launch |
|---|---|---|
| Google Cloud (new project, e.g. `rektbull-prod`) | Cloud Run, Cloud Build, Artifact Registry, Secret Manager, logs | Worker ≈ $15–25/month (always on); API pennies at low traffic |
| Postgres: Neon or Supabase free plan, or Cloud SQL | The database | $0 to start; Cloud SQL ≈ $10/month |
| Anthropic API | AI token reports (`REPORT_MODEL`) | Pay per report; spend shows in `/v1/admin/provider-usage` |
| Coinbase Developer Platform | x402 facilitator (`CDP_API_KEY_*`) | Free |
| Etherscan (V2 API) | Contract sources, approval history | Free plan |
| Blockscout | Fallback explorer | Free plan |
| 0x | Sell tests in token checks | Free plan |
| RPC provider (Alchemy, QuickNode, or similar) | Your own endpoints for each chain (`RPC_URLS_*`); public RPCs are the fallback | Free plans |
| Resend | Alert and confirmation email | Free up to 3,000 emails/month |
| NOWPayments (optional) | A second checkout in any coin, forwarded to your Safe | A fee per payment (see its dashboard) |
| Telegram bot (@BotFather) | Telegram alerts | Free |
| Domain registrar | `rektbull.com` (owned), `rektbull.app` (to register) | ≈ $15/year for `.app` |

Later (section 6): Chrome Web Store ($5 once), Microsoft Partner Center
(free), npm (free), and Apple Developer ($99/year) only if we do Safari.

## 4. Settings

### Wallets (you make them; only public data leaves your device)

| Setting | What | How |
|---|---|---|
| `CRYPTO_DEPOSIT_XPUB` | Extended **public** key; each top-up gets its own address from it | From a hardware wallet account used only for RektBull deposits. Write down its derivation path. Sweeping deposits is done by you, from that wallet |
| `X402_PAY_TO` | Where x402 USDC on Base arrives | A Safe or hardware-wallet address. Receive-only |
| `ADMIN_WALLETS` | Wallets that can use the admin panel (`/admin`, [ADMIN.md](ADMIN.md)) | Your own address(es) |
| `CLAIM_FEE_WALLET_EVM` | Where claim fees arrive (many different tokens) | A Safe or hardware-wallet address, receive-only; on every EVM chain we cover (a Safe needs deploying on each). Unset = claims carry no fee |
| `SWAP_FEE_WALLET_EVM` | Where the 1% trade fee arrives, on Base | A Safe or hardware-wallet address, receive-only. Needed for the trade desk at launch |
| `SESSION_KEY_ADDRESS` | RektBull's trading key (the KMS key's address) | Automatic trading only (section 8). Leave unset at launch |

Check before launch: an invoice made by the deployed site shows an address
your own wallet software also derives from that account (Claude checks the
first few). If they differ, the derivation path is wrong and deposits would
land where you can't reach them.

### Secrets (Secret Manager; every one must exist before the first deploy)

| Secret | Value | Used by |
|---|---|---|
| `rektbull-database-url` | Postgres URL with `sslmode=require` | api, worker |
| `rektbull-jwt-secret` | `openssl rand -hex 32` | api, worker |
| `rektbull-anthropic-api-key` | Anthropic key | api |
| `rektbull-cdp-api-key-id`, `rektbull-cdp-api-key-secret` | CDP key | api |
| `rektbull-etherscan-api-key` | Etherscan key | api, worker |
| `rektbull-blockscout-api-key` | Blockscout key | api, worker |
| `rektbull-zeroex-api-key` | 0x key | api |
| `rektbull-telegram-bot-token` | From @BotFather | api, worker |
| `rektbull-telegram-webhook-secret` | `openssl rand -hex 32` | api |
| `rektbull-resend-api-key` | Resend key (sending only) | api, worker |
| `rektbull-nowpayments-api-key`, `rektbull-nowpayments-ipn-secret` | From the NOWPayments dashboard. Not using it yet? Create both with the value `unused` and leave `NOWPAYMENTS_ENABLED` unset | api, worker |
| `rektbull-vapid-private-key` | From `npx web-push generate-vapid-keys`. **Never change the pair** once live: it ends every browser subscription | api, worker |

```bash
printf %s "$VALUE" | gcloud secrets create rektbull-jwt-secret --data-file=-
```

(`printf %s`, not `echo`, so no newline ends up in the secret.)

### Other settings (set once on each service; deploys keep them)

| Setting | api | worker | Value at launch |
|---|---|---|---|
| `NODE_ENV` | ✔ | ✔ | `production` (the image sets it) |
| `PUBLIC_URL`, `SIWE_URI` | ✔ | ✔ | `https://rektbull.com` |
| `SIWE_DOMAIN` | ✔ | | `rektbull.com` |
| `OPERATOR_NAME`, `PRIVACY_CONTACT` | ✔ | | The person or company responsible; an address someone reads |
| `ANALYZER_URL` | ✔ | | The contract analyzer's `run.app` address (DEPLOY.md, "The contract analyzer"). Unset, contract audits are refused and not charged |
| `INDEXNOW_KEY` | ✔ | | Optional: a random 32-character hex string (`openssl rand -hex 16`). Tells Bing, which feeds ChatGPT's and Copilot's search, when a digest is published |
| `SAME_AS` | ✔ | | Optional: RektBull's official profile URLs, comma-separated (e.g. the X account), once they exist. Ties the brand together for search and AI answers |
| `OPERATOR_POSTAL_ADDRESS` | ✔ | ✔ | A postal address for the newsletter's footer (a PO box is fine); without it no newsletter is sent |
| `CRYPTO_DEPOSIT_XPUB`, `PAYMENT_CHAINS` | ✔ | ✔ | Section 4; `ethereum,bsc,base` |
| `X402_PAY_TO` | ✔ | | Section 4 |
| `CLAIM_FEE_WALLET_EVM`, `YIELD_FEE_WALLET_EVM` | ✔ | | Section 4 |
| `ADMIN_WALLETS` | ✔ | | Your address |
| `RPC_URLS_ETHEREUM`, `_BASE`, `_BSC`, `_ARBITRUM`, `_OPTIMISM`, `_POLYGON`, `_SOLANA` | ✔ | ✔ | Your endpoints. They carry API keys: restrict them to RektBull's use in the provider's dashboard. **Set `RPC_URLS_SOLANA` before launch** (a free Helius or Alchemy plan): the launch check reads about 150 Solana calls per token, and the public endpoint refused about a third of them in testing (the check then refuses rather than guess, and isn't charged) |
| `PROVIDER_DAILY_LIMITS` | ✔ | ✔ | Just under each free plan's daily limit (see `.env.example`) |
| `TELEGRAM_BOT_USERNAME` | ✔ | ✔ | Without the @ |
| `EMAIL_FROM` | ✔ | ✔ | `RektBull <alerts@rektbull.com>` |
| `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | ✔ | ✔ | From the same pair; `mailto:` an address you read |
| `REPORT_MODEL`, `REPORT_EFFORT` | ✔ | | The defaults unless we choose otherwise |
| `NEW_WALLET_CHECK_CHAINS` | ✔ | | Default |
| `NOWPAYMENTS_ENABLED` | ✔ | ✔ | `true` once NOWPayments is set up (payout wallet, crypto only, IPN secret, IPN URL `https://rektbull.com/v1/nowpayments/ipn`) |
| `TRADING_ENABLED` | ✔ | ✔ | `true` after the smoke test's small real trade (section 5 D) |
| `AUTO_TRADING_NETWORKS` | ✔ | ✔ | `{}` until the Trade Router is deployed on Base (otherwise the page would offer the test network) |
| `YIELD_AUTO_ENABLED`, `YIELD_ROUTERS` | | | **Unset** (automatic rebalancing stays off) |

```bash
gcloud run services update rektbull-api --region=us-central1 \
  --update-env-vars=PUBLIC_URL=https://rektbull.com,SIWE_URI=https://rektbull.com,SIWE_DOMAIN=rektbull.com
```

`cloudbuild.yaml` uses `--update-env-vars`, so these survive every deploy.
(It used `--set-env-vars` until this plan, which would have wiped them on each push to `main`.)

## 5. Deployment, step by step

**A. Google Cloud (you, with Claude's commands)**

1. Create the project and link billing. Set a **budget alert** (e.g. $50/month)
   so a runaway cost shows up the same day.
2. Enable the APIs: Cloud Run, Cloud Build, Artifact Registry, Secret Manager.
   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
     artifactregistry.googleapis.com secretmanager.googleapis.com
   gcloud artifacts repositories create rektbull --repository-format=docker --location=us-central1
   ```
3. Service accounts, one per service, with only what each needs:
   ```bash
   for s in api worker; do
     gcloud iam service-accounts create rektbull-$s
   done
   # Each may read only its own secrets (repeat per secret in the table above):
   gcloud secrets add-iam-policy-binding rektbull-jwt-secret \
     --member=serviceAccount:rektbull-api@$PROJECT_ID.iam.gserviceaccount.com \
     --role=roles/secretmanager.secretAccessor
   ```
   Neither gets any KMS role. `rektbull-trade` isn't created until the trade desk resumes.
4. Let Cloud Build deploy as those accounts: grant the Cloud Build service
   account `roles/run.admin`, and `roles/iam.serviceAccountUser` on
   `rektbull-api` and `rektbull-worker` only.
5. Database: create it, put its URL in `rektbull-database-url`. Migrations
   001–007 (and any added by section 1) run when the first service starts.
   Turn on daily backups (Neon and Cloud SQL both have them) and test a restore once.
6. Create every secret in section 4.

**B. First deploy**

7. A Cloud Build trigger on pushes to `main`, using `cloudbuild.yaml`, with
   `_DEPLOY_TRADE=false`. Run it once by hand.
8. Set the other settings (section 4) on both services. Run the trigger again
   so the services restart with them.
9. Check the worker log says `worker started: deposit watcher and risk
   monitor`, and the API log has no startup errors. Open the `run.app` URL.

**C. Domain and email (you add the records; Claude gives them and checks)**

10. Map `rektbull.com` to `rektbull-api` (Cloud Run domain mapping; Google
    gives the A/AAAA records). The website, the API (`/v1`), the extension and
    the Snap all use `rektbull.com`. Redirect `www.rektbull.com` and
    `rektbull.app` to it.
11. If a load balancer is put in front later, re-check client IPs (the app
    trusts one proxy hop; a wrong count breaks per-IP free-use limits).
12. Email: verify `rektbull.com` in Resend (SPF and DKIM records), then add
    DMARC at `p=quarantine`. Until Resend is set up, publish `v=spf1 -all`
    and DMARC `p=reject` so nobody can send as rektbull.com.
13. Telegram: make the bot, then point its webhook at the site:
    ```bash
    curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
      -d url=https://rektbull.com/v1/telegram/webhook \
      -d secret_token=$TELEGRAM_WEBHOOK_SECRET -d 'allowed_updates=["message","edited_message","my_chat_member","chat_member","callback_query"]'
    ```

**D. Smoke test (before telling anyone)**

Automated (Claude, against `https://rektbull.com`):

- [ ] `/`, `/safety`, `/extension`, `/privacy` load, with the stylesheet;
      `/privacy` shows the real `OPERATOR_NAME` and `PRIVACY_CONTACT`.
- [ ] `/research`: subscribe a test address, confirm it from the email,
      then publish the first digest and check it arrives with the postal
      address and an unsubscribe link that works.
- [ ] `/trade` says "Trading is switched off on this server for now." until
      `TRADING_ENABLED` is set, and automatic trading says it opens when the
      router is deployed.
- [ ] A free approval preview on a known wallet; a token quick check without
      signing in uses the per-IP free allowance and names its sources.
- [ ] A sign-in message names `rektbull.com` (no domain warning in the wallet).
- [ ] An x402 call without payment answers 402 with the right `payTo` and price.
- [ ] CORS: `/v1/presign/check` answers the Snap's preflight; `/v1/credits` doesn't.
- [ ] Security headers present; HTTP redirects to HTTPS.

By hand (you, with a real wallet and small amounts):

- [ ] Sign in with MetaMask, and once with a smart wallet (Coinbase Smart Wallet: EIP-6492).
- [ ] Top up $5 of USDC on Base: the invoice address matches your own
      derivation; credits arrive after confirmations.
- [ ] Buy Safety Pro (30 days) from credits; the page shows it.
- [ ] If NOWPayments is on: a $5 top-up in another coin; the credits arrive, and the payment reaches your Safe.
- [ ] Run an approval cleanup on a wallet with one old approval; sign the revoke.
- [ ] Add a wallet to the risk monitor; link Telegram, email (confirm the
      link, check it isn't in spam) and browser push; send a test alert to each.
- [ ] Load the unpacked extension; link it; on a test site, a signature
      request shows RektBull's verdict.
- [ ] Find money: check your wallet on `/find`; claim one small Merkl reward
      or airdrop and see the fee arrive in the fee wallet.
- [ ] Download your data; delete it; the extension link stops working.
- [ ] Sweep the $5 deposit with your own wallet, to prove you can reach deposits.

**E. Watch the first week**

- Logs: errors in Cloud Logging, with an alert on the worker restarting or
  the deposit watcher falling behind.
- `/v1/admin/provider-usage`: provider calls against the free-plan limits, and Anthropic spend against report income.
- The budget alert.

**Rolling back:** Cloud Run keeps every revision. Send traffic back to the
last good one (`gcloud run services update-traffic rektbull-api --to-revisions=REV=100`),
then fix forward in a PR. Migrations only ever add (CLAUDE.md), so the older
revision still works against the newer database.

## 6. After launch: extension, Snap and the MCP Registry

**Browser extension** (`npm run extension:zip`):

*Rule (decided 4 November 2026): the extension keeps one purpose, checking a
transaction or signature before the wallet signs it, and nothing is added that
could risk store rejection. Features that live on the site (portfolio, claims,
yield, trading, voting) stay there; the extension may only link to them.*

1. Chrome Web Store: developer account ($5 once), listing (Claude writes the
   text, the permission reasons and the screenshots), privacy policy link
   `https://rektbull.com/privacy`, single-purpose statement. Review takes
   days to a few weeks; the `<all_urls>` content script gets extra scrutiny.
2. Microsoft Edge Add-ons: the same package, free.
3. Safari only if users ask ($99/year, needs a Mac build).

**MetaMask Snap** (`snap/`):
1. Test the `SNAP_ENV=test` build in MetaMask Flask against the live site.
2. Run Snapper (Sayfer's Snap scanner), with your go-ahead first: it runs
   code from npm.
3. Publish `@rektbull/presign-check` to npm: an npm account with 2FA, an `NPM_TOKEN`
   secret on GitHub, and a publish workflow Claude adds then.
4. Ask MetaMask to allowlist it (network access, so it can call rektbull.com):
   their form, with a short demo video you record. No audit is required for
   these permissions.
5. Until it's allowlisted, only Flask can install it; say so on `/extension`.

**MCP Registry** (`server.json`; the full guide is [MCP_REGISTRY.md](MCP_REGISTRY.md)):

*You run the commands and add the DNS record; Claude guides each step and
checks the record and the listing. About 30 minutes, free.*

- [ ] Once `https://rektbull.com/mcp` answers in public, install
      `mcp-publisher`.
- [ ] Make the key pair outside the repo, and keep `key.pem` in your password
      manager (never in the repo, a chat or the server).
- [ ] Add a **new** TXT record on the root of `rektbull.com`:
      `v=MCPv1; k=ed25519; p=…` (alongside the SPF record, not replacing it).
      Claude checks it.
- [ ] `mcp-publisher login dns --domain rektbull.com …`, then
      `mcp-publisher validate` and `mcp-publisher publish` from the repo.
- [ ] Claude checks that `com.rektbull/mcp` is listed and its address answers.
- [ ] Later, with your go-ahead: other MCP directories (Claude's, Cursor's).

## 7. Legal and before telling the public

- [ ] A lawyer reviews `/privacy` and terms of use for where we serve
      (EU/UK GDPR at least), and the fee wording for paid checks and claims.
- [x] **Stated on the site (decided 8 November 2026):** nothing on RektBull
      is financial, investment, legal or tax advice or a recommendation: in
      every footer, in full on `/about#not-advice` (every desk named), as a
      notice on Find money, Governance, Trade and Opportunities, in the
      results of yield proposals and proposal summaries, and on every page of
      the contract audit's PDF.
- [ ] The lawyer still confirms that the yield proposals and governance tools
      don't count as regulated investment advice where we serve: a
      disclaimer states our position, but regulators look at what a feature
      does, so the review stays on this list.
- [ ] Terms of use page (not written yet): no guarantees on checks, the
      user signs everything, refunds as the payment gate does them.
- [ ] Real-wallet testing ([REAL_WALLET_TESTING.md](REAL_WALLET_TESTING.md)):
      section 5 (one small real trade you sign on Base) before
      `TRADING_ENABLED=true`; the rest before automatic trading opens.
- [ ] Marketing follows [POSITIONING.md](POSITIONING.md) (crypto safety for
      people and their agents; never "safe" or "earn X%"). The launch campaign
      is [LAUNCH_CAMPAIGN.md](LAUNCH_CAMPAIGN.md); search is
      [SEO.md](SEO.md) (at launch: Search Console and Bing verified, sitemap
      submitted).

## 8. Turning things on later (not part of this launch)

**Automatic yield rebalancing:** [YIELD_ROUTER.md](YIELD_ROUTER.md), "Before
switching it on": audit and deploy the Yield Router, set `YIELD_ROUTERS`,
deploy the trade service, then `YIELD_AUTO_ENABLED=true`.

**Automatic trading (trade desk, stage 2):**

1. Deploy the Trade Router and Safe Module on Base from the owner's hardware
   wallet, fees to the owners' Safe, and verify the source on Basescan:
   [BASE_DEPLOYMENT.md](BASE_DEPLOYMENT.md). The script checks every parameter
   onchain first and prints the `AUTO_TRADING_NETWORKS` entry for step 3.
   (The Yield Router follows once its own audit passes.)
2. Create the KMS key and the `rektbull-trade` service account
   ([DEPLOY.md](DEPLOY.md)); sign one Base Sepolia transaction with it.
3. Set `SESSION_KEY_ADDRESS` (the key's address) and `AUTO_TRADING_NETWORKS`
   with the Base entry (router, tokens and venue, the same shape as
   `src/trade/networks.js`). `/trade` then offers automatic trading on Base.
4. Run the trigger with `_DEPLOY_TRADE=true`.
5. Finish [REAL_WALLET_TESTING.md](REAL_WALLET_TESTING.md) with small limits
   before telling anyone.

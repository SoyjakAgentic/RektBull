# AI agents: what to bring over from soyjak-agentic, and the tab

*Proposed and decided 7 November 2026. The owner's decisions are in
"Decided" below; each step is built in its own PR.*

## Decided (7 November 2026)

- **The seven desks become agents with a schedule and alerts.** Each one gets an "on" switch, a schedule and alert channels (email, Telegram), running what its desk already does.
- **Port both:** Launch Safety (bundle detector and insider tracer), and the Contract Audit Agent **with Soyjak's `analyzer` service** (Slither in its own container).
- **Build both community agents:** Group Guard and Channel Poster.
- **Leave out:** the generic Social Media Poster (LinkedIn, Instagram and the rest), news and sentiment, and the NFT scout.
- **RektBull's own X agent drafts only;** the owner posts by hand (option C in [SOCIAL_AGENTS.md](SOCIAL_AGENTS.md)), which is free.
- **Order:** RektBull's own social agents go last, once the Telegram channel, the group and the X account exist (see "Order" below).

## What "agent" means on RektBull

A RektBull agent is **a job that runs for you**, on a schedule or when
something happens. It reads chains and data sources, checks what it finds, and
then tells you, or prepares something for your wallet to sign.

- **Where AI is used:** it writes up what was found (reports, summaries, the digest). It never decides facts.
- **Who signs:** never the agent. The only exception is an automatic trade or yield move, inside limits your own wallet wrote onchain (session keys, [SESSION_KEYS.md](SESSION_KEYS.md)).

This is stricter than Soyjak, where agents are open-ended AI prompts with
tools. That strictness is the selling point: **an agent that can't make
facts up.**

## Soyjak's crypto agents, one by one

Soyjak has 23 crypto and social agents. **Seven of them are already in
RektBull as desks.** They only need presenting as agents, with a schedule and
alerts, not porting.

| Soyjak agent | What it does | In RektBull already? | Recommendation |
|---|---|---|---|
| Crypto Assistant | Front door: wallet findings, approvals, token scan | **Yes**: Home's ask box and checkup | Present as an agent; nothing to port |
| Wallet Guardian (`walletGuardian.js`) | Watches wallets for risky approvals, look-alike addresses | **Yes**: the risk monitor (Safety Pro) | Present as an agent |
| Airdrop Claim Assistant | Checks eligibility; prepares the claim to sign | **Yes**: Find money / Opportunities | Present as an agent (scheduled re-check, alert when something's claimable) |
| DAO Governance Digest | Proposal summaries, deadlines, delegate votes | **Yes**: Governance, with vote alerts | Present as an agent; add the weekly digest of a wallet's DAOs |
| Yield Rebalance Advisor (and Auto) | Better rates; moves within limits | **Yes**: yield proposals; automatic built, switched off | Present as an agent; Auto when switched on |
| Pre-Trade Safety Check | Contract audit plus market data before buying | **Yes**: the token check and the Trade desk | Present as an agent |
| Meme Coin Trader | Trades meme coins within limits | **Partly**: the Trade desk (session keys, EVM) | Later: Solana and Robinhood Chain need their own session-key design |
| **Smart Contract Audit Agent** | Static triage of verified Solidity: 28 checks, Slither, compiler bugs | **No** | **Port.** The strongest new safety product; paid (it costs real compute). Needs Soyjak's `analyzer` service (Slither in its own container) brought over too. **Several days** |
| **Launch Bundle Detector, and Insider Wallet Tracer** (meme-launch safety squad) | Was a new token's early supply bundled by insiders, and are they selling? | **No** | **Port.** Squarely on-brand ("is this a rug?"), and meme-able. Starts with Solana and Base launches. **About a week** |
| Whale Tracker, and Whale + News Correlation | Large wallet moves and exchange flows | **No** | Later. It's intel more than safety, and good data is paid (Arkham, Nansen) |
| Established Token Due Diligence (fan-out) | Market, whales, news and contract checks, in one report | **Mostly**: the full token report | Fold the missing parts into the report rather than port the squad |
| DAO Treasury Monitor, and DAO Ops Bundle | A DAO's treasury and governance loop | **No** | Later, as a paid plan for DAOs (business, not retail) |
| Token Analyst | Price, volume, fundamentals | **Yes**: Markets, Discover | Nothing to port |
| Crypto News Intel, and Sentiment Analysis | Sentiment-scored news | **No** | Skip: hard to source well, and against "every fact names its source" |
| NFT Scout | Floor, rarity, wash trading | **No** | Skip for now (NFTs are a low priority, see [SCOPE.md](SCOPE.md)) |
| Blockchain Data Validator | Compares indexers | **No** | Skip (an internal tool, not a product) |
| **Telegram Channel Agent** | Drafts and posts for a user's Telegram channel, with approval | **No** | See "Agents for communities" below |
| **Social Media Poster** | Posts for a user's X, LinkedIn, Facebook and Instagram | **No** | **Left out** (decided): a general marketing tool, off-brand for a safety site |

## Agents for communities (new, on-brand)

Generic social posting tools (scheduling posts to LinkedIn and Instagram)
don't fit a crypto safety brand. They're crowded, and **they mean holding
users' account tokens**, a liability RektBull doesn't need.

Two community agents do fit, and both are built from RektBull's own checks:

1. **Group Guard (a Telegram bot for crypto groups).** Project teams add it to their group.
   - It checks every link and contract address posted against GoPlus, RektBull's token check and phishing lists.
   - It deletes known scam links and warns on risky tokens, with sources.
   - It flags new members copying an admin's name or photo, and answers "is this the real contract?" from the project's own settings.
   - **Why it fits:** it's the most useful thing a safety brand can put in front of crypto communities. It markets itself (every warning says "checked by RektBull") and needs no user secrets: projects add our bot.
   - **Price:** free for small groups; paid for large ones, in crypto.
2. **Channel Poster (for project teams).** The same Telegram poster RektBull uses for its own channel ([SOCIAL_AGENTS.md](SOCIAL_AGENTS.md)), opened to projects:
   - It posts their governance votes, reward campaigns, or hack alerts relevant to their chain, drafted from RektBull's data, approved by them.
   - **Build order:** build it for RektBull first, then open it to others.

An X scheduler for users is left out: X's API pricing makes it costly per
user, and the scheduling tools already do it better.

## The tab

**One tab, "AI agents"**, replacing today's "Agents", in three parts:

1. **Your agents:**
   - Wallet Guardian, Claim Assistant, DAO Digest, Yield Advisor, Trading Agent and Pre-Trade Check, each with its schedule, alerts and price.
   - Later: Contract Audit and Launch Safety.
   - Each agent card links to the desk where it runs, so nothing is built twice.
2. **For communities:** Group Guard and Channel Poster.
3. **For builders and their agents:**
   - What's on `/agents` today: x402 services ranked by real payers, and the AI-agent protocols.
   - Links to the MCP server and pay-per-call.

**Why one tab, not two:**
- "Agents" (the x402 directory) and "AI agents" (agents for you) side by side in the menu would confuse.
- The menu has room for exactly one more item before it wraps on a laptop.

The address stays `/agents`, so nothing already shared or indexed breaks.

## Order (decided)

1. **The tab**, with the seven agents RektBull already has, each with an "on" switch, a schedule and alerts. **Built** (`src/services/myAgents.js`, `/agents`): Wallet Checkup and Claim Assistant (free), Wallet Guardian, Token Watch, DAO Votes and Yield Watch (Safety Pro), and the Trading Agent's exit alerts.
2. **Launch Safety** (bundle detector and insider tracer). **Built** (`src/services/launchSafety.js`): the launch check on the Safety page ($0.50, 2 points, in Safety Pro) and the Launch Safety agent, on the six EVM chains and Solana. Rebuilt as deterministic onchain checks with sources (Soyjak's were AI prompts with tools): first-hour buyers, shared funders, links to the deployer up to 3 steps, what they hold now, and alerts when they sell.
3. **Group Guard**, with Channel Poster for project teams. **Group Guard built** (`src/services/groupGuard.js`, `/agents/group-guard`): RektBull's bot, made an admin in a project's Telegram group, checks every posted link against GoPlus's phishing list and the group's official sites (removing known phishing), warns about contract addresses that aren't the official one and tokens GoPlus flags on the group's chains, and flags members whose names copy an admin's or claim "support". Settings by the group's admins with commands; no message text stored; daily limits per group; free. **Channel Poster built** (`src/services/channelPoster.js`, `/agents/channel-poster`): added to a project's channel as an admin, it drafts posts from DefiLlama's hack record, the project's Snapshot space and Merkl campaigns on its protocol, sends each to the admin who added it with Post and Skip buttons, and posts only on that tap. RektBull's own channel (step 5) can use the same poster.
4. **Contract Audit Agent**, with the analyzer service. **Built** (`src/services/contractAudit.js`, `analyzer/`, the Safety page's "Audit a contract", `/agents/contract-audit`): the verified source (and a proxy's implementation), Slither in its own Cloud Run service, the checklist's pattern checks and the compiler's known bugs, as flags for a person to confirm; Claude writes the plain-English summary from those results only (in Soyjak the model decided which leads were real). $9 an audit; refused and not charged when the analyzer can't run.
5. **RektBull's own Telegram channel poster and X drafts**, once the channel, the group and the X account exist and the owner sends the details ([SOCIAL_AGENTS.md](SOCIAL_AGENTS.md)): one to two days.
6. **Later:** whale tracking, DAO treasury plans, and the meme trader on Solana.

Each step is its own PR, and each port leaves Soyjak untouched until it's
switched over ([MIGRATION_FROM_SOYJAK.md](MIGRATION_FROM_SOYJAK.md)).

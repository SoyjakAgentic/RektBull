# Launch campaign: "Check your wallet"

*Planned 5 November 2026, before launch. Built on
[POSITIONING.md](POSITIONING.md) and [SEO.md](SEO.md). Weeks count from launch
day (week 1). The launch date isn't set, so nothing here has a calendar date
yet.*

## 1. Overview

- **Name:** Check your wallet.
- **In one sentence:** Get people to paste their wallet into RektBull's free
  checkup the week a hack is in the news, and keep them with the weekly digest
  and alerts. Get agent builders to plug in the MCP server.
- **Main goal (first 6 weeks):** **2,000 wallet checkups** run by people other
  than us.
- **Secondary goals (first 6 weeks):**
  - 300 confirmed newsletter subscribers.
  - 100 wallets signed in.
  - 20 paid runs (x402, points or credits).
  - 10 outside agents or apps calling the MCP server or the API.
  - The extension live in the Chrome Web Store.

These targets are a first guess with no history behind them. Revisit them after
week 2 with real numbers.

## 2. Who it's for

**Primary: people with a wallet who've had a scare.** They've seen a friend
drained, clicked something they regret, or read about a hack, and now they
want to know: am I exposed? They use DeFi on Ethereum, Base or Arbitrum, hold
more than they'd like to lose, and can't read a contract. They spend time on X
(crypto accounts), Farcaster, Telegram groups, Reddit (r/ethereum,
r/CryptoCurrency, r/defi), YouTube explainers, and the newsletters they trust.
*Stage: aware of the problem and looking for a check they can trust.*

**Secondary: builders of AI agents that hold or move money.** Developers on
Base, building with x402, MCP, Coinbase's AgentKit and similar. They need checks
their agent can call, and a way to pay per call. They spend time in the Base and
x402 builder channels, on GitHub, at hackathons, on X (developer accounts), and
in MCP directories. *Stage: building now and evaluating tools.*

## 3. Messages

**Core:** *Don't get rekt: paste your wallet and see what's at risk, in seconds,
free. Every finding with its source.*

| Message | For | Proof |
|---|---|---|
| Your old approvals are still open, and drainers use them | People | The checkup lists every open permission on six chains, with its value at risk and the revoke ready to sign |
| You might be owed money you never claimed | People | Unclaimed rewards and airdrops, each checked onchain, claimed from your own wallet |
| We show where every fact comes from | Both | Each finding names its source (GoPlus, Etherscan, DefiLlama, Merkl, onchain); nothing is guessed |
| Your agent should check before it pays | Builders | MCP server (18 read-only tools), x402 pay-per-call, the x402 services ranked by real payers |
| We never touch your funds | Both | Your wallet signs everything; RektBull holds no keys |

**By channel:** short and urgent on X ("X was drained through approvals. Check
yours: rektbull.com"); patient and teaching in guides and the newsletter;
precise and technical for builders (endpoints, tool lists, a code snippet).

**Never:** "safe", "protected", "guaranteed", "earn X%", "best yield". See
POSITIONING.md for why.

## 4. Channels

All free: the budget is near zero, and paid crypto ads are heavily restricted
anyway (Google and Meta require certification and limit what can be shown).

| Channel | Why | Format | Effort |
|---|---|---|---|
| **X: the RektBull account** | Where hacks break and spread; the main place for primary users | Hack-response posts within hours, the memes, a weekly digest thread, short screen recordings of the checkup | Medium |
| **Telegram channel: RektBull** (broadcast, only RektBull posts) | Crypto users live on Telegram; a channel reaches them without the noise of a group | The weekly digest when it's published, alerts for large hacks, launch news | Low (can be automatic: see below) |
| **Telegram group: the RektBull community** | Questions, "was I drained?", feedback and bug reports; where trust is built or lost | Answers, not announcements. Pin the official links and the "we never DM first" rule | Medium (needs moderation daily) |
| **The weekly digest (email)** | Already built; it keeps people coming back | Weekly, owner-reviewed, with "check your wallet" in every issue | Low (Claude drafts, the owner reviews) |
| **Search (SEO)** | Slow but compounding; see SEO.md | Guides, protocol record pages, digest archive | Medium |
| **Communities** (Reddit, Farcaster, Telegram, Discord) | People ask "was I drained?" there every day | **Helpful answers, not promotion.** Link to the check only where it answers the question, and follow each place's rules | Medium |
| **Builder channels** (Base and x402 communities, MCP Registry, GitHub) | Where agent builders choose tools | A launch post for builders, a working code snippet, the registry listings | Low to medium |
| **Earned media** (crypto press, newsletters, researchers) | Credibility; one story can bring thousands | A data story: "Of 114,000 x402 endpoints, about 200 have real users" (from the Agents desk), and the monthly hack numbers | Medium |
| **Product Hunt** (week 3 or 4) | A one-day spike, and a lasting link | A builder-angle launch: MCP plus the checkup | Medium |

**Not now:** paid ads, influencer deals, and sponsored newsletter placements
(possible later, paid in crypto and only within the ad rules), conferences.

**Who posts (decided 7 November 2026):** RektBull's own accounts: the X account,
the Telegram channel (broadcast) and the Telegram group (community). Posts speak
as RektBull, not as a person. The official handles go in `SAME_AS` (search and
AI answers then tie them to the site) and on the About page's "How to tell it's
really us".

**Automatic posting:**
- **Telegram channel:** RektBull's alert bot can post each published digest there, plus alerts for large hacks, once the bot is made an admin of the channel. Claude can build this when wanted; it's not built yet.
- **X:** posting automatically needs X's paid API, so X stays manual, or goes through a scheduling tool the owner chooses.

### The Telegram group: keeping scammers out

Crypto Telegram groups are where impersonators hunt: fake "admins" DM members
offering "support", a "wallet sync" or an airdrop link. For a safety brand, one
member drained this way is the worst possible story. Before the group opens:

- [ ] **Pinned rule, first message:** "RektBull's team never DMs you first, never asks for a seed phrase or private key, and never asks you to connect or 'verify' your wallet. Anyone who does is a scammer: report them." The same line goes in the group description.
- [ ] **Official links** in the description and the pin: rektbull.com, the X account, the channel. Nothing else is official.
- [ ] **New members** pass a captcha and can't post links, media or forwards for their first 24 hours (Telegram's own permissions plus an anti-spam bot).
- [ ] **Few admins**, each with a visible "RektBull team" title. Make admin names hard to copy (the impersonators copy the name and photo exactly).
- [ ] **Hide the member list** (Telegram's "Hide members" setting), so scammers can't scrape it to DM people.
- [ ] **A daily look** at the group, at least in the first weeks. Delete scam posts quickly, and say publicly that they were scams.
- [ ] **Never post a contract address or a "claim" link** in the group: RektBull has no token, and saying so in the pin heads off the most common fake.

## 5. Content calendar

The owner posts, reviews and approves; Claude drafts everything and builds the
pages. About 20% of slots are left open for hacks, which can't be scheduled.
When one happens, a hack-response post goes out the same day.

| Week | Content | Channel | Owner / notes | Status |
|---|---|---|---|---|
| −2 | Smoke test passed (LAUNCH_PLAN 5D); Search Console and Bing verified, sitemap submitted | Site | Owner adds the DNS record; Claude checks | To do |
| −2 | X profile set up: bio, link, pinned "what RektBull is" post, preview image tested | X | Claude drafts; owner posts | To do |
| −2 | Telegram channel and group created, with the group's safety settings (section 4) and the pinned rule; handles added to `SAME_AS` and the About page | Telegram | Owner creates; Claude drafts the pin and description | To do |
| −2 | First digest drafted, reviewed and published, so `/research` isn't empty | Site, email | Owner reviews | To do |
| −1 | Extension submitted to the Chrome Web Store (review takes days to weeks) | Store | LAUNCH_PLAN section 6 | To do |
| −1 | Guides 1 and 2: "My wallet was drained: what now?" and "Revoking approvals, Permit2 included" | Site | Claude writes; owner reviews | To do |
| −1 | A 30-second screen recording of the checkup | X, site | Owner records; Claude scripts it | To do |
| 1 | **Launch post and thread:** what it checks, free, sourced, no custody | X, Farcaster | Launch day | To do |
| 1 | Builder launch post: MCP server, x402, code snippet | Base and x402 communities, X | Day 2 or 3 | To do |
| 1 | Digest #1 by email to the first subscribers | Email | Monday | To do |
| 2 | **x402 data story** published, then pitched to 5 to 10 writers and researchers | Site, press, X | Claude writes; owner pitches | To do |
| 2 | Guide 3: "NFT approvals and setApprovalForAll" | Site | | To do |
| 2 | MCP Registry listing (MCP_REGISTRY.md) | Registry | Owner, with Claude | To do |
| 3 | Protocol record pages (the first 100) live; announce "look up any protocol's record" | Site, X | Claude builds | To do |
| 3 | Product Hunt launch (builder angle) | Product Hunt | Prepare in week 2 | To do |
| 4 | Extension live (if approved): "check before you sign" post with a recording | X, store | Depends on store review | To do |
| 4 | Guide 4: "Letting an AI agent pay safely with x402" | Site, builder channels | | To do |
| 5 | Monthly hack numbers ("October in hacks"), from the hack tracker | Site, X, press | Claude drafts | To do |
| 6 | Look back: numbers against targets, what worked, the plan for the next 6 weeks | Internal | Claude prepares; owner decides | To do |
| Every week | The digest; 3 to 5 X posts; community answers where they genuinely help | | | Ongoing |

**What must come first:**
- the smoke test before any post;
- the preview image tested before the launch thread;
- the first digest published before inviting newsletter sign-ups;
- the extension posts only after store approval;
- the protocol pages built before announcing them.

## 6. Content pieces

| Piece | What's in it | Priority | When |
|---|---|---|---|
| Launch thread | The problem (open approvals, drainers); the checkup in 3 screenshots; free; sources; no custody; the link | Must | Week −1 |
| X profile and pinned post | What RektBull checks; never asks for a seed phrase; official links only | Must | Week −2 |
| "How to tell it's really us" note | The official domain and accounts; RektBull never DMs first or asks for a seed phrase or to "verify your wallet" | Must | Week −2 |
| 30-second checkup recording | Paste, results, revoke ready to sign | Must | Week −1 |
| Guides 1 and 2 | Wallet drained; revoking approvals with Permit2 | Must | Week −1 |
| Builder launch post | MCP URL, `claude mcp add` line, three tool examples, x402 per-call prices | Must | Week 1 |
| x402 data story | Endpoints listed and endpoints with real payers, usage that looks generated, method and sources | Must | Week 2 |
| Hack-response template | Fill-in post: what happened, how, the amount (source), "check your approvals", the link | Must | Week −1 |
| Product Hunt listing | Tagline, 4 images, maker comment | Nice | Week 2 |
| Guides 3 and 4 | NFT approvals; agents paying with x402 | Nice | Weeks 2 and 4 |
| Monthly hack numbers | Totals, techniques and the biggest cases, all from the tracker | Nice | Week 5 |

## 7. How we'll know

| Metric | Target (6 weeks) | Where it's counted |
|---|---|---|
| **Wallet checkups by others** (main) | 2,000 | The daily free-use counters (`free_usage`, product `home_checkup`) |
| Confirmed subscribers | 300 | Review card on `/research` (newsletter counts) |
| Wallets signed in | 100 | `accounts` table |
| Paid runs | 20 | Payment records (x402, credits, points) |
| Outside agents using MCP or the API | 10 | MCP and API counters (to add, see next steps) |
| Search clicks | Rising week on week | Google Search Console |
| Extension users | 50 once live | Chrome Web Store dashboard |

**How we count:** aggregate numbers only. No tracking scripts and no visitor
profiles, as the privacy page promises.

**Rhythm:** a short weekly note (numbers, plus what to repeat or drop) and a
fuller review at week 6. Claude can prepare both.

## 8. Budget

Near zero, and paid in crypto only.

| Item | Cost | Notes |
|---|---|---|
| Chrome Web Store developer account | $5 once | Already in LAUNCH_PLAN |
| Resend paid plan | About $20 a month | Only once the list nears 100 subscribers |
| Product Hunt, X, Farcaster, Reddit, registries | $0 | Time, not money |
| Reserve for later tests | Owner's choice | For example, one sponsored slot in a crypto newsletter after week 6, if the numbers say it's worth it |

## 9. Risks

| Risk | Mitigation |
|---|---|
| **Someone runs a clean checkup and is drained later, and blames RektBull** | The copy never says "safe"; results say a clean check isn't proof; hack posts say "check", never "protect". Reply publicly with facts and sources, never defensively |
| **Scammers impersonate RektBull** (fake sites, fake extensions, "support" DMs). Every safety brand that gets attention is copied | The "how to tell it's really us" note pinned from day one. Report clones to registrars, the Chrome store and X. Consider registering obvious lookalike domains |
| **Looking like spam in communities**, which gets RektBull banned or ignored | Help first, link second, follow each community's rules. Never post the same text twice. The owner posts as a person |
| **Traffic spikes use up the free data plans** (GoPlus, Etherscan, DefiLlama) | The daily allowances and provider limits already in place (FREE_TIER.md); watch `/v1/admin/provider-usage` daily in week 1 |
| **The extension's store review takes longer than planned** | The campaign doesn't depend on it: lead with the web checkup; the extension is a week-4 beat, moved if needed |

## 10. Next steps

1. **Owner:** pick a launch date, so the weeks become dates.
2. **Claude:** add a small owner-only stats endpoint (aggregate counts of
   checkups, sign-ins, subscribers, paid runs and MCP calls) so the targets can
   be read without tracking anyone. About an hour.
3. **Claude:** draft the launch thread, the X profile, the "it's really us"
   note, the hack-response template and guides 1 and 2, for the owner to
   review.
4. ~~Decide who posts~~: **decided**. RektBull's X account, Telegram channel and
   Telegram group, speaking as RektBull. **Owner:** send the handles once
   they exist, for `SAME_AS` and the About page.
5. **Claude, when wanted:** post published digests and large-hack alerts to the
   Telegram channel automatically (the bot as a channel admin).
6. **Owner:** approve the targets in section 1, or set your own.

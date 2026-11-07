# SEO: audit and plan

*4 November 2026, before launch. Follows [POSITIONING.md](POSITIONING.md):
crypto safety for people and their AI agents. No SEO tool is connected (Ahrefs
or Semrush would add volumes and difficulty scores), so demand and difficulty
below are judgements from the search results, not measured numbers. Re-check
them with Google Search Console a month after launch.*

## Summary

**The site's foundations are strong:**
- It's fast: about 164 KB on a first visit, gzip, fonts served from the site itself, and ethers loaded only where it's needed.
- It works on phones, with a browser test at 375 px.
- It uses HTTPS.
- It has real, sourced data that thin "is it safe" blogs can't match.

**It was invisible to search.** Every title was the brand alone ("RektBull
Safety"). There was no canonical address, no sitemap, no robots.txt, no link
previews and no favicon. Most descriptions were too long, and Trade had none.
**This change fixes all of that** (see the checklist).

**The three things that matter most from here:**
1. **Pages that answer "is \<protocol\> safe?" with the record.** These searches are mostly answered by thin blogs and AI-written pages today. RektBull has live, sourced data for each protocol: hacks, audits, age and money locked.
2. **A short set of guides** for the questions people ask in a panic, such as "my wallet was drained, what now?" and "how do I revoke approvals?". Each guide ends in the free checkup.
3. **Being first for agents.** Searches like "x402 services" and "crypto MCP server" are small but growing, and almost no one ranks for them yet.

**Overall: a good foundation, but almost no content yet.** Today the site is
tools, and tools alone rank only for the brand name.

## What was fixed in this change

| Page | Issue | Severity | Fix (done) |
|---|---|---|---|
| All | Title was the brand only, with no search terms | Critical | Titles written for searches, 60 characters at most, in `src/pages/seo.js` |
| All | No canonical address; `?wallet=` and `?week=` addresses could be indexed as duplicates | High | `<link rel="canonical">` on every page |
| All | `/safety.html` and the other template files were reachable as broken duplicate pages | High | 301 redirects to the clean address |
| All | No sitemap or robots.txt | High | `/sitemap.xml` and `/robots.txt` (nothing blocked: the pages load their data from `/v1` while rendering) |
| All | No link previews (Open Graph or Twitter tags), so shared links showed bare | High | Tags plus a 1200×630 preview image (`/og.png`) |
| All | No favicon (search results on phones show one) | Medium | `favicon.svg`, a 48 px PNG, an Apple touch icon and a 512 px icon |
| Most | Descriptions were 170 to 210 characters, so cut off in results | Medium | Rewritten to 130 to 145 characters, each with what you get |
| Trade | No description | Medium | Added |
| Home | No structured data | Low | `Organization` and `WebSite` |
| Unknown pages | A JSON `{"error":"not_found"}` page shown to people | Low | An HTML 404 page (noindex) pointing to the checkup; the API still answers JSON |

`test/seo.test.js` keeps these from regressing: lengths, uniqueness, one
canonical, the preview tags, the sitemap, the redirects and the 404.

## Technical checklist (after this change)

| Check | Status | Details |
|---|---|---|
| Titles and descriptions | Pass | Unique, within limits, tested |
| Canonical addresses | Pass | Every page, absolute, from `PUBLIC_URL` |
| robots.txt and sitemap | Pass | 14 pages; the 404 is left out |
| Duplicate addresses | Pass | `.html` redirects; `www` and `rektbull.app` redirect at deploy (LAUNCH_PLAN 5C) |
| Link previews | Pass | Open Graph, Twitter card, 1200×630 image |
| HTTPS | Pass | Cloud Run |
| Mobile | Pass | Browser tests at 375 px on every desk |
| Speed | Pass | gzip, self-hosted fonts, ethers only on `/safety` and `/trade`, no images in pages |
| Structured data | Pass (basic) | `Organization` and `WebSite` on the home page. FAQ rich results are now limited to government and health sites, so not worth adding |
| Content rendered in the browser | Pass (partly) | Tables still load from `/v1` by script, but each data page now opens with a server-rendered **At a glance** block of its key facts, and digests have their own server-rendered pages. Protocol record pages, when built, should be server-rendered the same way |
| `lastmod` in the sitemap | Pass | On the digest pages, from their publish dates; the fixed pages have none until they change on a schedule |
| Breadcrumbs and page data | Pass | `WebPage` and `BreadcrumbList` on every page; `AboutPage` on `/about`; `Article` on each digest |
| Questions and FAQ data | Pass | A visible Questions section on 12 pages, and `FAQPage` data built from the questions shown, so the two always match |
| Fonts | Pass | The heading and body fonts are preloaded, so the first view doesn't shift when they arrive |
| Caching | Pass | Stylesheet, scripts and images kept 10 minutes; fonts a year; digest pages 5 minutes |
| Search Console and Bing Webmaster | **Not set up** | A launch task: verify by DNS TXT, submit the sitemap |
| Image alt text | Pass | Pages have no `<img>`; icons are inline SVG marked `aria-hidden` |

## AI search: being the answer, not just a link

ChatGPT, Claude, Perplexity, Gemini and Google's AI answers read pages
differently from a results page: they quote a passage that answers the
question, from a page they can read without a script, and prefer sources that
name where their facts come from. RektBull's sourcing is a natural fit. What's
in place:

| What | Why it matters for AI answers | Where |
|---|---|---|
| **Every crawler welcome**, the AI ones named (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot, Google-Extended, Applebot-Extended, Bingbot) | An assistant can only cite what it may read. Blocking the training crawlers is the owner's call; the search and user-fetch ones should stay open | `/robots.txt` |
| **At a glance**, rendered on the server | Most AI crawlers don't run scripts; without this, Markets, Research, Agents and Discover look empty to them. Short, dated, sourced sentences are what gets quoted | `src/pages/glance.js` |
| **Questions**, answered plainly on 12 pages | Assistants match questions to passages that answer them in the first sentence | `src/pages/seo.js` (`FAQ`) |
| **Digest pages** with a date, a byline, `Article` data and their sources | Fresh, dated, citable writing, the kind assistants quote for "this week in crypto hacks" | `/research/<Monday>` |
| **About and sources** | Who runs it, how each check works, every data source: the trust signals search engines weigh for money topics, and what an assistant needs to describe RektBull correctly | `/about` |
| **`llms.txt`** | A plain-text map of the site and the agent tools (MCP, OpenAPI) for assistants and agents | `/llms.txt` |
| **IndexNow** | Bing (which feeds ChatGPT's and Copilot's search) hears about a new digest in minutes | `INDEXNOW_KEY`; `src/services/indexnow.js` |
| **`sameAs`** | Ties the brand's official profiles together, so assistants don't confuse RektBull with lookalikes | `SAME_AS` |
| **One consistent description** | The same one-line summary in the home page data, `llms.txt`, About and the MCP server's instructions | POSITIONING.md |

**Checking it after launch:** ask ChatGPT, Claude, Perplexity and Gemini
questions such as "how do I check my wallet's token approvals?", "what is x402?",
"which x402 APIs do agents actually use?" and "crypto hacks this month", once a
month. Note whether RektBull is cited, and fix what they get wrong in the page
they quote. Search Console shows Google's AI answers' clicks within the normal
search figures; Bing Webmaster Tools shows Copilot's.

**Not done, on purpose:**
- Separate Markdown copies of every page. `llms.txt` and server-rendered text cover it without a second copy to keep in sync.
- Hidden text for bots. Everything a crawler reads, people see too.

## Keyword opportunities

Demand and difficulty are judged from the search results (no tool data).
"Ranking" is none for all of them, since the site isn't live yet.

| Keyword (and variants) | Difficulty | Opportunity | Intent | Content |
|---|---|---|---|---|
| is \<protocol\> safe (aave, morpho, pendle, ethena …) | Moderate: thin blogs and AI pages | **High** | Informational | Server-built protocol record pages (see below) |
| my wallet got drained what to do | Moderate | **High** | Informational, urgent | Guide that ends in the checkup |
| x402 services, x402 api list, x402 bazaar | Easy (new) | **High** | Commercial | `/agents` (live) |
| crypto mcp server, web3 mcp, wallet safety mcp | Easy to moderate | **High** | Commercial | `/developers` (live), MCP Registry listing |
| check wallet approvals, token approval checker | Hard (Revoke.cash, Etherscan) | Medium | Transactional | Home checkup and `/safety`; guide |
| how to revoke token approvals | Hard (wallet help centres, Revoke.cash) | Medium | Informational | Guide covering Permit2 and NFTs too |
| revoke permit2 approval, permit2 explained | Easy to moderate | **High** | Informational | Guide (RektBull checks Permit2; many tools don't) |
| setapprovalforall drainer, nft approval scam | Easy | Medium | Informational | Guide |
| wallet drainer extension, transaction simulation extension | Hard | Medium | Commercial | `/extension` once it's in the Chrome store |
| honeypot checker, is this token a scam | Hard (crowded) | Medium | Transactional | `/safety`; guide on what a check can and can't tell you |
| how to check if a crypto site is phishing | Moderate | Medium | Informational | Guide (the pre-sign check uses GoPlus's phishing list) |
| crypto hacks 2026, biggest crypto hacks | Moderate | **High** | Informational | Server-built hack tracker pages by year and technique |
| oracle manipulation hacks (and other techniques) | Easy to moderate | Medium | Informational | Same, per technique |
| \<protocol\> hack, \<protocol\> exploit | Hard for big ones (news), easy for small | Medium | Informational | Protocol record pages carry each hack |
| stablecoin depeg tracker, is usdc depegged | Moderate | Medium | Informational | `/markets` stablecoins, built on the server |
| usdc lending rates aave compound | Moderate | Medium | Commercial | `/find` rates, as facts. **Not "best yield"** (a regulated claim) |
| unclaimed airdrops checker, check airdrop eligibility | Hard, and full of scam sites | Medium | Transactional | `/find`; "never connect a wallet to check eligibility" as the angle |
| merkl rewards claim | Easy | Medium | Transactional | `/find` and `/opportunities` |
| snapshot proposal explained, dao votes open | Easy | Low | Informational | `/governance` |
| token approval api, wallet risk api | Easy | Medium | Commercial | `/developers`, OpenAPI |
| crypto safety weekly newsletter | Easy | Medium | Navigational | `/research#newsletter` |
| crypto portfolio tracker | Very hard (Zerion, DeBank, Zapper) | Low | Commercial | **Don't target**; the portfolio is a feature, not a destination |
| crypto ai agent, ai crypto agent, crypto ai agents | Hard (agent tokens, trading bots, launchpads) | **High** | Mixed | `/agents` and the agent pages: "AI agents that can't make facts up". Never "AI trading bot that earns" |
| crypto wallet monitoring bot, wallet alert bot, approval alerts | Moderate | **High** | Commercial | `/agents/wallet-guardian` (live) |
| airdrop checker bot, unclaimed rewards alert | Hard, and full of scam sites | Medium | Transactional | `/agents/claim-assistant` (live): "never connect a wallet to a DM link" |
| token rug alert, honeypot alert, rug pull detector bot | Moderate | **High** | Commercial | `/agents/token-watch` (live); Launch Safety when built |
| dao vote alerts, snapshot proposal notifications | Easy | Medium | Commercial | `/agents/dao-votes` (live) |
| defi exploit alerts, aave position alerts | Easy to moderate | Medium | Commercial | `/agents/yield-watch` (live) |
| crypto trading agent with limits, ai trading agent safe | Hard | Medium | Commercial | `/agents/trading-agent` (live): sold on onchain limits, never on returns |
| ai agent tokens, is \<agent token\> safe | Moderate | Medium | Informational | The AI-agent protocols on `/agents`, linked to protocol records |

## Content to build, in order

| # | Topic | Why | Format | Priority | Effort |
|---|---|---|---|---|---|
| 1 | ~~Protocol record pages~~: **done**. `/dapps/<slug>` for every protocol with $10M or more locked (about 560), plus the `/dapps` index. They're built on the server, use the data Discover already caches, and are in the sitemap; Discover and Agents link to them | Answers the biggest searches better than anyone ranking now; live data stays fresh | Programmatic page: the record as quotable sentences, facts with sources, hacks with write-ups, audits, "Before you use it", related protocols, Questions with FAQ data | Done | — |
| 1b | ~~AI agent pages~~: **done** (7 November 2026). `/agents/<name>` for each of the seven agents, each aimed at one search: what it checks with sources, schedule, alerts, price, what it never does, Questions with FAQ data, `SoftwareApplication` data. In the sitemap and `llms.txt`; the home page title and hero, About and the Organization description now say "crypto safety and AI agents" (POSITIONING.md) | "Crypto AI agents" is the identity's second pillar | Programmatic page from the agents' own catalog | Done | — |
| 2 | ~~Digest archive pages~~: **done** (`/research/<week>`, server-rendered, `Article` data, in the sitemap) | Fresh, unique, sourced content every week, which search engines reward | Server-rendered article with its facts | Done | — |
| 3 | **Hack tracker pages**: by year and by technique ("crypto hacks 2026", "oracle manipulation hacks") | Steady searches; DefiLlama, Rekt News and De.Fi rank with lists, not explanations | Server-rendered stats plus a plain-English "how this attack works" | High | Moderate |
| 4 | **Guides** (`/learn`): wallet drained, revoking approvals, Permit2, NFT approvals, phishing sites, honeypots, what a token check can't tell you, using an agent safely with x402 | The questions people ask in a panic, each ending in the free checkup | 800 to 1,500 words each, with screenshots | High | Quick win (a few hours) each |
| 5 | **Glossary**: approval, allowance, Permit2, drainer, honeypot, rug pull, x402, MCP, session key | Links between guides; answers "what is" questions | Short entries on one page or several | Medium | Moderate |
| 6 | **Comparison pages**: RektBull and Revoke.cash, RektBull and wallet pop-up warnings | Searches made just before choosing; must be fair and factual | Landing page | Medium | Moderate |
| 7 | **x402 Bazaar data story**: how many listed APIs have real users (about 200 of 114,000 have 5 or more payers) | Original data people link to and journalists cite | Research post, refreshed monthly | Medium | Moderate |

**Rules for all of it:**
- **No "is it safe?" answers.** A protocol page may ask the question in a heading ("Is Aave safe? What the record shows") but never answers yes. It shows the record and says what the record can't tell you.
- **Sources on every fact,** as everywhere else on RektBull.
- **Built on the server.** Pages meant to rank are rendered with their text, not loaded by script.
- **Rewards and rates are facts, never a pitch.** No "best", no "earn X%".

## Competitors

No SEO tool is connected, so these are judgements from the search results
and the products themselves.

| | RektBull | Revoke.cash | De.Fi | DefiLlama | Wallet help centres |
|---|---|---|---|---|---|
| Strongest searches | None yet | "revoke approvals" | The scanner, its database of hacks | Hacks, money locked, protocols | "how to revoke…" |
| Content depth | Tools, no articles | Tool, plus guides and exploit write-ups | Tools and a database | Data pages, very broad | Step-by-step help |
| Authority | New domain | High, long-standing | High | Very high | Very high (MetaMask, Uniswap) |
| What they lack that RektBull has | | Claims, monitoring, agents, sources on token facts | Agents, the pre-sign extension, no custody of keys for checks | Wallet checks, plain-English explanations | Any check of your own wallet |
| What they have that RektBull lacks | | Years of links, 100+ chains | Brand, breadth | Authority, every protocol | Trust, the default first click |

**Where RektBull can win:**
- protocol record pages that explain;
- guides that end in a working check;
- searches about agents, x402 and MCP.

**Where it can't win soon:** head terms like "revoke token approvals" or
"crypto portfolio tracker". Those come later, through links.

## Action plan

**Quick wins (done in this change):**
- Keyword titles, descriptions, canonical addresses, robots.txt, sitemap, link
  previews, favicon, structured data, `.html` redirects and the 404 page.
- The hero now says the checks work for your AI agent too.

**Also done (search and AI answers):**
- **At a glance** blocks on Research, Markets, Agents and Discover.
- **Questions** on 12 pages, with matching FAQ data.
- **Breadcrumbs and page data** on every page.
- **The About and sources page.**
- **Server-rendered digest pages**, in the sitemap with their dates.
- **`llms.txt`**, AI crawlers named in robots.txt, and **IndexNow**.
- **Font preloading** and **caching**.

**At launch (an hour or two, the owner with Claude):**
1. **Search Console:** verify `rektbull.com` with a DNS TXT record (one more record next to SPF and the MCP Registry's), then submit `https://rektbull.com/sitemap.xml`. High impact, under an hour.
2. **Bing Webmaster Tools:** import from Search Console. Bing also feeds some AI assistants' search. 15 minutes.
3. **Test a shared link** on X and Telegram to confirm the preview shows the image.
4. **Set `INDEXNOW_KEY`** (`openssl rand -hex 16`), and `SAME_AS` once the official profiles exist.
5. **Check the pages with Google's Rich Results Test** (the home page, a desk page, a digest page) and the Schema Markup Validator. Claude can run the checks and read the results with you.

**This quarter (Claude builds, in this order):**
1. ~~Protocol record pages~~: done (`/dapps`, about 560 pages). **Next for them:** parent pages that group versions (Aave V2 and V3 under "Aave"), since people search for the brand, not the version.
2. ~~Digest archive pages (`/research/<week>`)~~: done.
3. **Four guides first:** wallet drained, revoking approvals with Permit2, NFT approvals, using an agent safely with x402. Impact high, a few hours each, written for the owner to review.
4. **Hack tracker pages** by year and technique. Impact medium to high, about a day.
5. **The x402 data story**, monthly, from the Agents desk's own numbers. Impact medium, and it earns links.
6. **A month after launch:** read Search Console's queries and re-rank this list by what people actually search.

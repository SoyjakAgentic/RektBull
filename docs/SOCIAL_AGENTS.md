# RektBull's own social agents: Telegram poster and X scheduler

*Written 7 November 2026. **Not built yet,** and built last of the agents
([AI_AGENTS.md](AI_AGENTS.md)): the owner first sets up the Telegram channel,
the group and the X account, then sends the details below, then Claude builds
them. **Decided:** X is drafts only, posted by hand (option C). They post for **RektBull's own**
accounts (the X account, the Telegram channel). Agents that post for users'
accounts are a separate question ([AI_AGENTS.md](AI_AGENTS.md)).*

Both follow the rules the rest of RektBull follows:
- Every fact in a post comes from RektBull's own data and names its source.
- Nothing claims something is safe or promises returns ([POSITIONING.md](POSITIONING.md)).
- A person approves what goes out, except the post types the owner switches to automatic.
- The bull's faces are used as [brand/README.md](../brand/README.md) says.

## 1. The Telegram channel agent

**What it posts:**

| Post | When | Content | Approval |
|---|---|---|---|
| **Weekly digest** | When the owner publishes a digest | The digest's opening section, a link to its page (`/research/<week>`), and a link to subscribe by email | Automatic: publishing the digest is the approval |
| **Large hack** | When the hack tracker records a hack over a threshold (e.g. $5M), checked hourly | What was hit, how much, how it was done, the source link, a "check your approvals" link, and the rekt bull | Starts as a draft for the owner, with one tap to send; can be switched to automatic later |
| **Stablecoin off peg** | When a large stablecoin goes off peg by over 0.5%, or loses 10% of its supply in a week | The coin, the numbers, the source, the shook bull | Draft; switchable to automatic |
| **Announcements** | When the owner writes one | Launches and new features | The owner writes and sends |

**How it works:**
- RektBull's existing Telegram bot (`TELEGRAM_BOT_TOKEN`, already used for alerts) is made an **admin of the channel** with only the "post messages" right. No new bot, no new key.
- Drafts appear for the owner on the admin page, and as a Telegram message to the owner with "Send" and "Skip" buttons.
- Each post is sent once, recorded, and never repeated if the worker restarts.
- Text only, plus at most one image (a sticker or meme from `brand/`). Links go to rektbull.com only.

**Details the owner sends before launch:**
- [ ] The channel's `@username`, or its numeric id for a private channel.
- [ ] The bot added as a channel admin, with "post messages" only.
- [ ] Which posts start automatic (the recommendation: the digest only).
- [ ] The hack threshold (default $5M) and quiet hours, if any (e.g. no posts 00:00 to 07:00 UTC).
- [ ] The language and tone: the house style is plain English and short, matching the site.

**Settings (to add when built):**
- `TELEGRAM_CHANNEL_ID`
- `TELEGRAM_CHANNEL_AUTO` (which post types go out without approval)
- `TELEGRAM_HACK_THRESHOLD_USD`

## 2. The X (Twitter) schedule agent

**What it does:**
- Keeps a **queue** of posts for the X account and sends each at its scheduled time.
- Drafts come from:
  - the same events as the Telegram agent (digest, large hacks, depegs);
  - the launch calendar ([LAUNCH_CAMPAIGN.md](LAUNCH_CAMPAIGN.md)), for example memes, guides and the x402 data story;
  - the owner, who writes their own.
- Every draft waits for the owner's approval on the admin page, with edit, reschedule and delete. The owner can switch the digest post to automatic.
- Threads are supported (for the launch thread and the digest), and so are images from `brand/`.

**Posting to X needs X's API, which is paid** for any real volume:
- X's pricing changes, so check the current tiers before choosing. As of late 2026, the free tier allows only a small number of posts a month, and the paid "Basic" tier is roughly $200 a month.
- **Option A, the X API directly:** the owner creates an X developer app for the RektBull account and chooses a tier. The keys go in Secret Manager (`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`), never in the repo.
- **Option B, a scheduling service** (Buffer, Typefully, Postiz or similar): RektBull's agent puts drafts into that service's queue through its API, and the service posts them. That costs the service's subscription instead of X's API, and its own approval screen can be used.
- **Option C, no automation on X (chosen):** the agent drafts, and the owner copies and posts by hand. It's free, and a sensible start until volume justifies a cost. The admin page shows each draft with a "copy" button and an "open in X" link that fills in the post, and the owner marks it posted.

**Details the owner sends before launch:**
- [ ] The X handle.
- [x] Option C: drafts only, posted by hand (decided 7 November 2026). A or B can come later if volume justifies the cost.
- [ ] How many posts a day at most, and the posting times (time zone).
- [ ] Which post types, if any, may go out without approval.

## What both agents never do

- **No engagement bots.** No auto-replies to strangers, follows, likes or reposts, and no buying of any of those. They break X's rules and look like spam.
- **No DMs.** RektBull never DMs first; that's our anti-impersonation promise.
- **No other links.** No contract addresses, no "claim" links, and no links anywhere but rektbull.com and a post's own sources.
- **No unsourced claims.** Nothing about a project that isn't in RektBull's data with its source, and no predictions.

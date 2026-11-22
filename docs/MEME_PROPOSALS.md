# Meme coin proposals

The owner asked for these on 22 November 2026, built the way the Polymarket
proposals are: **rules pick, the AI explains, the user decides and signs**.
Code: `src/memes/signals.js`. The page: the "AI picks" card on `/launches`.
Everything starts **off** (admin panel, "AI forecasts and proposals").

Meme coins have no stated probability and no outcome to score against, so the
AI isn't asked whether a coin is mispriced: it couldn't judge that, and most
meme coins go to zero. Code picks by stated rules; the AI only explains them.

## How a coin is picked

1. **Watch.** GeckoTerminal's trending lists are mostly coins months old. On
   22 November 2026 none of the 120 trending pools read on Base and BNB Chain
   was between 1 hour and 14 days old. So young coins are gathered over time
   into a watchlist (`meme_watchlist`). Every 5 minutes (`meme_refresh_minutes`, the owner's choice: meme momentum moves fast),
   on Base, BNB Chain and Solana, it adds:
   - GeckoTerminal's newest pools (2 pages) and trending pools;
   - the launchpads' just-graduated coins from the live feed (Virtuals,
     four.meme, pump.fun).

   A coin leaves the watchlist after 14 days, or once it's 6 hours old and
   trading under a tenth of the volume minimum.
2. **Rules** (code, `RULES` and the admin's thresholds), on each watched coin's
   figures from DexScreener (all its pairs, 30 coins a call). A coin passes
   only if:
   - **Liquidity:** at least $50,000 (`meme_min_liquidity_usd`).
   - **Volume:** at least $100,000 traded in 24 hours (`meme_min_volume_usd`).
   - **Buys:** at least 200 buy transactions in 24 hours (`meme_min_buys`).
   - **Age:** between 1 hour and 14 days. No first-hour sniping.
   - **Buying against selling:** more buys than sells, from 1.1 to 1 up to 4
     to 1. Above that is the one-way buying of a coin that can't be sold.
   - **Price:** the last hour between −10% and +50%, and not up more than 300%
     in 24 hours. No spike to chase.
   - **Warning signs:** none of the "bad" signs its trading shows
     (`discover.poolSignals`).

   Passing coins are ranked by turnover (24-hour volume against liquidity,
   capped at 10) times buying pressure (buys against sells, capped at 3),
   nudged by the last hour's move.
3. **Checks**, on the top coins until `meme_picks` (3) pass:
   - **EVM:** GoPlus's flags. A "bad" flag, or a tax over 5%, drops the coin.
   - **Solana:** the mint. A freeze or mint authority still set drops the coin.
   - **Under a week old:** the bundle and insider check (Launch Safety). A
     bundle found drops the coin.
   - **A check that couldn't run drops the coin too.** Nothing unchecked is
     proposed.
   - A coin picked in the last 24 hours isn't picked again.
4. **Explain.** `MEME_PROPOSAL_MODEL` (Haiku 5.5 by default, no web search)
   gets the facts and the checks, each with its source.
   - It writes two or three sentences and up to three risks.
   - It's told not to add news, opinions, targets or predictions, and not to
     call the coin safe.
   - **A reason naming a number that isn't in the facts is thrown away**, and
     a plain one built from the facts is used instead (CLAUDE.md: never let
     AI fill gaps with guesses).

## The scorecard (public)

- **Every coin that passed the rules is kept**, the picks and all the rest. A
  coin counts at most once a day, so busy coins don't weigh more.
- **Scoring:** each is priced again 1 hour and 24 hours later (DexScreener,
  30 tokens a call). A coin with no pair left counts as 0, which is what
  holders got. A window missed because the source was down stays empty, not
  guessed.
- **What's compared:** the picks' median change and share up, and the share
  down by half or more, against all the rest. This shows whether the checks and
  the ranking add anything to the rules alone.
- **Where:** `GET /v1/memes/track-record`, and on the page. Only picks already
  scored at 24 hours are listed; newer ones go only to the users they were
  offered to.

## On the page: the price now, and expiry

The owner asked for these on 22 November 2026, so users can see how a pick has
done since it was made.

- **Price now:** each pick shows its price now against its price when picked:
  "Now $0.00156 (+30% since the pick)", read from DexScreener when the page
  opens. It's one call per chain for all the user's picks, cached a minute.
  When it can't be read, the pick says so; it never shows a stale number as
  current.
- **Expiry:** a pick not acted on expires `meme_expiry_hours` (6 by default)
  after it was made, because the facts behind it are stale. It's shown as
  expired, with no "Review the trade". Approving one that has just expired is
  refused. The worker expires picks every minute, and the page does it too when
  it loads.
- **The Trade desk** still shows the live price, and runs every check again,
  before the user signs.

## What a user pays

- **Picks are free, for every signed-in user who asks for them.** The owner
  decided this on 22 November 2026: meme and alt-coin trading is the main
  earner, and the 1% trade fee pays for the picks. They cost about $1 to $5 a
  month to run in all, whatever the number of users (see Cost).
- **"Review the trade"** opens the Trade desk on that coin.
- **A price can be set** in the admin panel (`meme_proposal_usd`). Acting on a
  pick then costs that much in AI credits, once. Only accounts with credits
  are offered picks, and a user without credits is pointed to a top-up.
- **The trade:** the Trade desk runs its full checks again, and the bundle
  check for a young coin. The user sets the amount and signs. RektBull's usual
  1% trade fee applies, and Points rebate it as usual.
- **Opting in:** "Send me meme coin picks" on the page (`ai_proposal_settings.meme`).
  Picks count against the user's daily limit for meme picks.
- **Meme Watch** watches what the user bought through RektBull, as it does
  for any trade.

## Cost

- **AI:** Haiku explains only new picks: at most 3 a run, and a coin is picked
  at most once a day. Each is about 800 tokens in and 200 out, about $0.0002.
  At the very most (3 picks in every one of 288 runs a day) that's about $5 a
  month. In practice it's nearer $1, because few coins qualify. It's shared
  by every user, and under the admin panel's daily AI budget.
- **Per user: nothing.** A pick is made once; offering it to more users only
  adds database rows.
- **Data**, every 5 minutes:
  - **GeckoTerminal:** about 9 calls a run, spaced 2.5 seconds apart. That's
    about 2,600 a day, about 2 a minute. With the live feed's own reads, still
    well under its free plan's 30 a minute.
  - **DexScreener:** one call per 30 watched coins a run. The watchlist stays
    small because dead coins leave it.
  - **The live feed:** one read per chain a run.
  - **The checks:** only on the top few coins, and cached.
- **When it runs:** the worker looks every minute, and a run is due 5 minutes
  after the last one started (`meme_runs`), whether or not it picked anything.
  A run never overlaps the one before.

## Before switching proposals on

1. Switch on "Run meme coin picks" only. Picks are made and scored, and nobody
   is offered anything.
2. Wait for a few hundred picks scored at 24 hours. Check that the picks do
   better than all the rest; most coins in both will fall.
3. Then switch on "Offer meme proposals".

## Never

- Calling a coin safe, or a pick a recommendation: the page says it's what
  stated rules found, with a public scorecard.
- Proposing a coin a check couldn't check.
- Trading for the user. Automatic meme trading comes later, through the
  audited Meme Router, whose limits are enforced onchain (docs/MEME_ROUTER.md).

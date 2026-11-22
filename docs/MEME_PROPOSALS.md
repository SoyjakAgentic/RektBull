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
   into a watchlist (`meme_watchlist`). Every 30 minutes (`meme_refresh_minutes`),
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

## What a user pays

- **Seeing a pick is free.**
- **Acting on one costs $0.25 of AI credits, once** (`meme_proposal_usd`, the
  owner's price, the same as a Polymarket proposal). "Review the trade" opens
  the Trade desk on that coin. A proposal can't be acted on without credits;
  the user is pointed to a top-up.
- **The trade:** the Trade desk runs its full checks again, and the bundle
  check for a young coin. The user sets the amount and signs. RektBull's usual
  1% trade fee applies, and Points rebate it as usual.
- **Opting in:** "Send me meme coin picks" on the page (`ai_proposal_settings.meme`).
  Picks count against the user's daily limit for meme picks.
- **Meme Watch** watches what the user bought through RektBull, as it does
  for any trade.

## Cost

- **AI:** Haiku explains at most 3 picks a run, 48 runs a day, about 1,000
  tokens each. That's well under $1 a day, shared by every user. Each call is
  under the admin panel's daily AI budget.
- **Data:**
  - GeckoTerminal: about 9 calls a run, about 430 a day.
  - DexScreener: one call per 30 watched coins a run. The watchlist stays
    small because dead coins leave it.
  - The live feed: one read per chain a run.
  - The checks run only on the top few coins.

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

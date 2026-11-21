# AI forecasts and proposals

The owner chose option (b) on 21 November 2026: the AI proposes trades, and the
user approves and signs each one. Proposals are paid from Safety Pro AI
credits. The AI never trades on its own. Everything here starts **off**
(admin panel, "AI forecasts and proposals").

## How it works (Polymarket, `src/forecasts/polymarket.js`)

1. **Screen.** The cheap model (`FORECAST_SCREEN_MODEL`, Haiku 5.5 by default)
   reads the busiest open binary markets, 200 by default, in groups of 20,
   every 6 hours. It uses Polymarket's own data only, with no web access. It
   gives each market a probability and flags the few with a concrete reason to
   think the price is materially wrong.
2. **Research.** The stronger model (`FORECAST_MODEL`, Sonnet 5.5 by default)
   researches each flagged market:
   - with web search, 3 searches by default;
   - at most 30 a day, biggest disagreement first, and each market at most
     once a day;
   - reading the market's resolution rules.

   A forecast keeps **only sources the search actually returned**, and a
   forecast with no real source is dropped, not stored as a guess (CLAUDE.md:
   never let AI fill gaps with guesses).
3. **Propose.** While proposals are on, a forecast becomes a proposal when:
   - its confidence is medium or high;
   - it beats the market price by the edge, 8 points by default, enough to
     cover Polymarket's fee, RektBull's fee and the profit share.

   It's offered to each user who opted in (`ai_proposal_settings`), up to their
   daily limit, at a limit price that still keeps the edge.
4. **Resolve and score.** When a market resolves, every forecast on it is scored
   with the Brier score, (probability − outcome)², and so is the market's own
   price at the time. The track record is public (`GET /v1/forecasts/track-record`)
   and on the Predictions page.

Forecasts are made once per market and shared, so the AI cost grows with the
markets read, not with users. Each call is counted in the AI usage report and
is under the admin panel's daily AI budget.

## What a user pays

- **Price and when it's charged:** each proposal costs `proposal_usd` ($0.05
  by default) of Safety Pro AI credits, charged when it's offered. A proposal
  is never charged twice.
- **Order of payment:** the 30-day allowance pays first, then an AI top-up
  (docs/PAYMENTS.md, $5, $20 or $50, paid with credits or RektBull Points).
  With neither, no proposal is offered.
- **Daily limit:** users set how many proposals a day they want (1 to 50).

## What approving does

"Review the order" marks the proposal approved and fills in the order form: the
market, the outcome, a limit order at the proposal's price. The user sets the
size, checks it, and **signs it themselves**. Nothing is traded by the AI.

## Before switching proposals on

1. Switch on "Run Polymarket forecasts" only. Forecasts are made and scored,
   and nobody is offered anything.
2. Wait until enough researched forecasts have resolved, and check that the
   AI's Brier score beats the market's.
3. Then switch on "Offer Polymarket proposals".

Cost at the defaults (docs estimate, measured in the AI usage report):

- **Screen:** about $1 a day.
- **Research:** up to 30 a day at about $0.15 each, so $4.50.
- **Total:** around $175 a month.

## Settings (admin panel; logged)

`polymarket`, `polymarket_proposals`, `markets`, `refresh_hours`,
`research_per_day`, `web_searches`, `edge_pct`, `proposal_usd`. The models are
`FORECAST_SCREEN_MODEL` and `FORECAST_MODEL` (environment), called only from
`src/ai/claude.js`.

## Next

- Hyperliquid proposals, built the same way: approving feeds the page's order
  or the automatic agent.
- Polymarket automatic trading through Session Keys, with full disclosure.

-- Meme coin proposals (docs/MEME_PROPOSALS.md).
-- The watchlist: young coins seen in GeckoTerminal's newest and trending pools and the launchpads' just-graduated
-- lists, kept up to 14 days (dropped sooner once they're dead), whose figures the rules read from DexScreener.
CREATE TABLE meme_watchlist (
  chain       TEXT NOT NULL,
  token       TEXT NOT NULL,
  symbol      TEXT,
  source      TEXT NOT NULL,              -- where it was first seen
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  dropped_at  TIMESTAMPTZ,                -- dead (no trading to speak of), or past 14 days
  PRIMARY KEY (chain, token)
);
CREATE INDEX meme_watchlist_live ON meme_watchlist (chain) WHERE dropped_at IS NULL;

-- A signal is one coin the rules picked in one run, after
-- the safety checks, with the facts behind it and the AI's short explanation of those facts. Every coin
-- that passed the rules in that run is kept too (picked = false), so the public scorecard can compare
-- the picks with everything the rules let through. Prices are read again 1 hour and 24 hours later.
CREATE TABLE meme_signals (
  id            BIGSERIAL PRIMARY KEY,
  run_id        UUID NOT NULL,
  chain         TEXT NOT NULL,
  token         TEXT NOT NULL,
  symbol        TEXT,
  name          TEXT,
  pool          TEXT,
  picked        BOOLEAN NOT NULL,
  score         NUMERIC NOT NULL,
  price_usd     NUMERIC NOT NULL,          -- when it was picked (GeckoTerminal)
  facts         JSONB NOT NULL,            -- the numbers the rules read, each with its source
  checks        JSONB,                     -- the safety checks run on a pick, each with its source
  reason        TEXT,                      -- the AI's explanation of the facts (picks only)
  risks         JSONB,
  model         TEXT,
  cost_usd      NUMERIC(10, 6),
  price_1h      NUMERIC,
  price_24h     NUMERIC,
  scored_1h_at  TIMESTAMPTZ,
  scored_24h_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX meme_signals_open ON meme_signals (created_at) WHERE scored_24h_at IS NULL;
CREATE INDEX meme_signals_picked ON meme_signals (created_at DESC) WHERE picked;
CREATE INDEX meme_signals_token ON meme_signals (chain, token, created_at DESC);

-- Meme proposals are AI proposals too: one row in ai_proposals per user and signal.
ALTER TABLE ai_proposals ALTER COLUMN forecast_id DROP NOT NULL;
ALTER TABLE ai_proposals ADD COLUMN signal_id BIGINT REFERENCES meme_signals(id);
ALTER TABLE ai_proposals ADD COLUMN chain TEXT;
CREATE UNIQUE INDEX ai_proposals_signal ON ai_proposals (account_id, signal_id) WHERE signal_id IS NOT NULL;
ALTER TABLE ai_proposal_settings ADD COLUMN meme BOOLEAN NOT NULL DEFAULT false;

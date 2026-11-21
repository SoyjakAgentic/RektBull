-- AI forecasts and proposals (docs/AI_PROPOSALS.md).
--
-- A forecast is the AI's view of one market, made once and shared: a cheap
-- screen of many markets, then research with web search on the few it flags.
-- Each is scored against the market's own price once the market resolves, so
-- the track record is public and measured, not claimed.
CREATE TABLE ai_forecasts (
  id              BIGSERIAL PRIMARY KEY,
  venue           TEXT NOT NULL CHECK (venue IN ('polymarket', 'hyperliquid')),
  stage           TEXT NOT NULL CHECK (stage IN ('screen', 'research')),
  market          TEXT NOT NULL,            -- Polymarket: the market slug; Hyperliquid: the coin
  question        TEXT,
  outcome         TEXT,                     -- Polymarket: the outcome the probability is for (the first, e.g. Yes)
  asset_id        TEXT,                     -- Polymarket: that outcome's token id
  ai_prob         NUMERIC(6, 4) NOT NULL,   -- the AI's probability of `outcome`
  market_prob     NUMERIC(6, 4),            -- the market's price for it when the forecast was made
  confidence      TEXT CHECK (confidence IN ('low', 'medium', 'high')),
  research        BOOLEAN NOT NULL DEFAULT false, -- screen: worth researching
  reasoning       TEXT,
  sources         JSONB NOT NULL DEFAULT '[]', -- URLs the web search actually returned
  model           TEXT NOT NULL,
  cost_usd        NUMERIC(12, 6) NOT NULL DEFAULT 0,
  resolved_value  NUMERIC(6, 4),            -- 1 if `outcome` happened, 0 if not
  resolved_at     TIMESTAMPTZ,
  brier_ai        NUMERIC(8, 6),            -- (ai_prob - resolved)^2: lower is better
  brier_market    NUMERIC(8, 6),            -- the same for the market's price
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ai_forecasts_market ON ai_forecasts (venue, market, created_at DESC);
CREATE INDEX ai_forecasts_open ON ai_forecasts (venue, created_at) WHERE resolved_at IS NULL;

-- Who wants AI proposals, and how many a day at most (each costs AI credits).
CREATE TABLE ai_proposal_settings (
  account_id    BIGINT PRIMARY KEY REFERENCES accounts(id),
  polymarket    BOOLEAN NOT NULL DEFAULT false,
  hyperliquid   BOOLEAN NOT NULL DEFAULT false,
  max_per_day   INTEGER NOT NULL DEFAULT 5 CHECK (max_per_day BETWEEN 1 AND 50),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A proposal offered to one user from one forecast. Nothing is traded until the user approves and signs.
CREATE TABLE ai_proposals (
  id            UUID PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id),
  forecast_id   BIGINT NOT NULL REFERENCES ai_forecasts(id),
  venue         TEXT NOT NULL,
  market        TEXT NOT NULL,
  side          TEXT NOT NULL,              -- Polymarket: the outcome to buy; Hyperliquid: long or short
  asset_id      TEXT,
  price_limit   NUMERIC(10, 6),             -- the most the AI's edge allows paying
  price_usd     NUMERIC(10, 4) NOT NULL,    -- what the proposal cost the user in AI credits
  paid_from     TEXT NOT NULL CHECK (paid_from IN ('allowance', 'topup')),
  status        TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'approved', 'dismissed', 'expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  acted_at      TIMESTAMPTZ,
  UNIQUE (account_id, forecast_id)
);
CREATE INDEX ai_proposals_account ON ai_proposals (account_id, created_at DESC);

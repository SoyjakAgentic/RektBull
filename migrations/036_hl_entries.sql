-- Hyperliquid entry proposals, phase 2 (docs/HYPERLIQUID.md, "Entry proposals"): stated rules on the deep
-- markets, each signal a full bracket (entry, stop-loss, take-profit), scored in R net of fees and funding.
-- In shadow (the forecasts setting `hyperliquid`) they're only logged and scored, in public; offered to users
-- who asked for them only once `hyperliquid_proposals` is switched on.
CREATE TABLE hl_signals (
  id              BIGSERIAL PRIMARY KEY,
  coin            TEXT NOT NULL,
  asset           INTEGER NOT NULL,
  rule            TEXT NOT NULL,              -- breakout, funding_fade, flush_reversal
  side            TEXT NOT NULL CHECK (side IN ('long', 'short')),
  entry_px        NUMERIC NOT NULL,           -- the mark price when the signal was made
  stop_px         NUMERIC NOT NULL,
  tp_px           NUMERIC NOT NULL,
  stop_pct        NUMERIC NOT NULL,           -- the stop's distance from the entry, % (1R)
  funding_hourly_pct NUMERIC,                 -- at entry, for the funding estimate
  facts           JSONB NOT NULL,             -- what the rule saw, each fact with its source
  offered         BOOLEAN NOT NULL DEFAULT false, -- made while proposals were offered (else shadow)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'tp', 'stop', 'expired', 'unscored')),
  resolved_at     TIMESTAMPTZ,
  exit_px         NUMERIC,
  r_1h            NUMERIC,                    -- R at each checkpoint, net of costs (null until reached)
  r_4h            NUMERIC,
  r_24h           NUMERIC,
  r_final         NUMERIC,                    -- at the take-profit, the stop, or the 24-hour close
  costs_r         NUMERIC,                    -- fees and estimated funding, in R
  checked_at      TIMESTAMPTZ
);
CREATE INDEX hl_signals_open ON hl_signals (status, created_at);
CREATE INDEX hl_signals_recent ON hl_signals (created_at DESC);
-- One open signal per market and rule at a time.
CREATE UNIQUE INDEX hl_signals_one_open ON hl_signals (coin, rule) WHERE status = 'open';

-- Which hours the rules ran, so each hourly candle is read once.
CREATE TABLE hl_signal_runs (
  hour       TIMESTAMPTZ PRIMARY KEY,
  markets    INTEGER NOT NULL,
  found      INTEGER NOT NULL,
  not_checked JSONB NOT NULL DEFAULT '[]',
  ran_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Automatic trading on Hyperliquid perps (docs/HYPERLIQUID.md).
--
-- A grant is the user's approval of RektBull's Hyperliquid agent wallet
-- (approveAgent, signed by the user's own wallet), plus the limits the user
-- chose. Hyperliquid enforces that an agent can trade and never withdraw or
-- transfer; the limits here are enforced by RektBull's trade service, not
-- onchain, and the page says so.
CREATE TABLE hl_auto_grants (
  id              UUID PRIMARY KEY,
  account_id      BIGINT NOT NULL REFERENCES accounts(id),
  wallet          TEXT NOT NULL,             -- the user's Hyperliquid account (their EVM wallet, lowercase)
  agent_address   TEXT NOT NULL,             -- RektBull's agent wallet the user approved
  valid_until     TIMESTAMPTZ NOT NULL,      -- Hyperliquid's own expiry for the approval
  max_trade_usd   NUMERIC NOT NULL CHECK (max_trade_usd > 0),
  max_day_usd     NUMERIC NOT NULL CHECK (max_day_usd > 0),
  max_leverage    INTEGER NOT NULL CHECK (max_leverage BETWEEN 1 AND 50),
  markets         TEXT[],                    -- NULL: any market deep enough for automatic trading
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX hl_auto_grants_one_active ON hl_auto_grants (account_id) WHERE status = 'active';

-- One automatic order: open a long or short, or close a position.
CREATE TABLE hl_auto_intents (
  id              UUID PRIMARY KEY,
  account_id      BIGINT NOT NULL REFERENCES accounts(id),
  grant_id        UUID NOT NULL REFERENCES hl_auto_grants(id),
  coin            TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('long', 'short', 'close')),
  size_usd        NUMERIC,                   -- opens: the position's size (notional), not the margin
  leverage        INTEGER,                   -- opens
  stop_loss_pct   NUMERIC,                   -- opens: a reduce-only stop placed with the order
  take_profit_pct NUMERIC,
  source          TEXT NOT NULL CHECK (source IN ('user', 'agent')),
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'done', 'failed', 'cancelled')),
  result          JSONB,
  filled_usd      NUMERIC,                   -- what filled, counted against the daily limit
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);
CREATE INDEX hl_auto_intents_queued ON hl_auto_intents (created_at) WHERE status = 'queued';
CREATE INDEX hl_auto_intents_account ON hl_auto_intents (account_id, created_at DESC);

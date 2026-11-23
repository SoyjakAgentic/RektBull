-- Hyperliquid proposals, phase 1 (docs/HYPERLIQUID.md, "Protecting positions"): fixes for a user's open
-- positions, a stop-loss or reducing by half, made by stated rules and prepared for the trading key in the
-- user's browser to sign. The relay accepts the proposal fee only on an order that matches a live proposal
-- here: reduce-only, in the proposal's market, for the account it was made for.
CREATE TABLE hl_proposals (
  id             UUID PRIMARY KEY,
  account_id     BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  wallet         TEXT NOT NULL,
  coin           TEXT NOT NULL,
  asset          INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  severity       TEXT NOT NULL,
  orders         JSONB NOT NULL,             -- the order wires, unsigned, all reduce-only
  fee_tenths_bps INTEGER NOT NULL,
  mark_px        NUMERIC,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  acted_at       TIMESTAMPTZ
);
CREATE INDEX hl_proposals_account ON hl_proposals (account_id, created_at DESC);

-- The deep markets every 5 minutes, for the open-interest alerts. Kept two days.
CREATE TABLE hl_market_snapshots (
  coin               TEXT NOT NULL,
  at                 TIMESTAMPTZ NOT NULL,
  mark_px            NUMERIC NOT NULL,
  open_interest_usd  NUMERIC NOT NULL,
  funding_hourly_pct NUMERIC,
  PRIMARY KEY (coin, at)
);

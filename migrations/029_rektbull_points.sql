-- RektBull Points (docs/POINTS.md): a rebate of trading-fee revenue, spendable on
-- subscriptions. Separate from the monthly free points for safety checks
-- (004_points_and_ai_usage). Positive rows are points earned, negative rows
-- points spent. One row per (source, ref), so a fee is never rebated twice.
CREATE TABLE reward_points (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  points      NUMERIC(20, 4) NOT NULL CHECK (points <> 0),
  kind        TEXT NOT NULL CHECK (kind IN ('rebate', 'spend')),
  source      TEXT NOT NULL,          -- swap, auto_swap, perps, perps_auto, polymarket_fill, polymarket_profit, pass
  ref         TEXT NOT NULL,          -- the trade, fill, batch or purchase it's for
  fee_usd     NUMERIC(20, 6),         -- rebates: the fee RektBull earned
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, ref)
);
CREATE INDEX reward_points_account ON reward_points (account_id, created_at DESC);

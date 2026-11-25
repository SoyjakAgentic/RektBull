-- Trailing stop-losses and take-profits in steps (src/trade/exitRules.js, docs/MEME_ROUTER.md and docs/SOLANA_ORDERS.md).
-- A trailing stop's trigger is trail_bps under peak_out, the highest value (for the whole order, in the coin it sells
-- for) seen on two price checks in a row; last_value_out is the last check's. The floor the user signed (min_out) never
-- moves. Take-profits placed together share a ladder id, numbered by step.
ALTER TABLE meme_orders
  ADD COLUMN trail_bps      INTEGER CHECK (trail_bps BETWEEN 100 AND 9000),
  ADD COLUMN peak_out       NUMERIC(78, 0),
  ADD COLUMN last_value_out NUMERIC(78, 0),
  ADD COLUMN ladder         TEXT,
  ADD COLUMN step           SMALLINT,
  ADD COLUMN steps          SMALLINT;

ALTER TABLE solana_orders
  ADD COLUMN trail_bps      INTEGER CHECK (trail_bps BETWEEN 100 AND 9000),
  ADD COLUMN peak_out       NUMERIC(39, 0),
  ADD COLUMN last_value_out NUMERIC(39, 0),
  ADD COLUMN ladder         TEXT,
  ADD COLUMN step           SMALLINT,
  ADD COLUMN steps          SMALLINT;

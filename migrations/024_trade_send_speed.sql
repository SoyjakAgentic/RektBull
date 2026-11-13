-- Protected sending (Trade desk, stage 1): how fast each user wants their own
-- trades in a block. 'standard' leaves the fee to their wallet; 'fast' and
-- 'fastest' ask the wallet for a priority fee read from the chain's recent blocks.
ALTER TABLE trade_settings ADD COLUMN send_speed TEXT NOT NULL DEFAULT 'standard' CHECK (send_speed IN ('standard', 'fast', 'fastest'));

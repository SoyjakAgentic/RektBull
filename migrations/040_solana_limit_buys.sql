-- Limit buys on Solana (src/trade/solanaOrders.js): a coin bought with the user's wrapped SOL when its price
-- comes down to their limit. For a limit buy, amount_in is SOL (lamports), min_out, trigger_out and ref_out
-- are the coin's raw units, `source` is the user's wrapped-SOL account, and `delivered` counts coins.
ALTER TABLE solana_orders DROP CONSTRAINT solana_orders_kind_check;
ALTER TABLE solana_orders ADD CONSTRAINT solana_orders_kind_check CHECK (kind IN ('stop_loss', 'take_profit', 'meme_watch_exit', 'limit_buy'));
ALTER TABLE solana_orders ADD COLUMN spend_usd NUMERIC; -- a limit buy's SOL in USD when placed, against the per-trade amount

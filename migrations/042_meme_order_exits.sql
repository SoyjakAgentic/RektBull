-- Exits with a buy on BNB Chain and Base (src/trade/memeOrders.js exitsForBuy): a stop-loss or take-profit the
-- user's wallet signs right after it sends a buy on the Trade desk. It waits, prepared and signed, for that trade
-- (trade_proposals) to be confirmed onchain, then opens; it's dropped if the trade fails.
ALTER TABLE meme_orders ADD COLUMN trade_id UUID REFERENCES trade_proposals(id) ON DELETE SET NULL;
CREATE INDEX meme_orders_waiting ON meme_orders (trade_id) WHERE state = 'prepared' AND trade_id IS NOT NULL;

-- One-click trading (Trade desk, stage 1): the buy and sell buttons each
-- user sets for themselves. Buys are dollar amounts (each still within
-- max_trade_usd when it's used); sells are shares of the holding.
ALTER TABLE trade_settings ADD COLUMN buy_presets_usd NUMERIC[] NOT NULL DEFAULT '{25,50,100}';
ALTER TABLE trade_settings ADD COLUMN sell_presets_pct NUMERIC[] NOT NULL DEFAULT '{25,50,100}';

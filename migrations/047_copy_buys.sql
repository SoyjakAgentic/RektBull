-- One-tap copies of a followed wallet's buys (docs/WALLET_TRACKER.md, "Copying a buy").
-- RektBull never buys from an alert: the alert carries a buy prefilled with these settings, and the user's own
-- wallet signs it on the Trade desk.

-- Each followed wallet's copy settings. copy_usd NULL: no copy button, the alert as before.
ALTER TABLE followed_wallets
  ADD COLUMN copy_usd      NUMERIC CHECK (copy_usd IS NULL OR copy_usd > 0), -- the preset amount for a copy of its buys
  ADD COLUMN copy_stop_pct NUMERIC CHECK (copy_stop_pct IS NULL OR copy_stop_pct > 0),
  ADD COLUMN copy_take_pct NUMERIC CHECK (copy_take_pct IS NULL OR copy_take_pct > 0),
  ADD COLUMN copy_sell_with BOOLEAN NOT NULL DEFAULT true;          -- the stop-loss also sells when this wallet sells

-- A stop-loss placed with a copy can also fire when the copied wallet sells the coin: at the market, never below
-- the stop's own floor (the order the user signed). NULL: a plain stop-loss.
ALTER TABLE solana_orders ADD COLUMN copy_wallet TEXT;
ALTER TABLE meme_orders ADD COLUMN copy_wallet TEXT;
CREATE INDEX solana_orders_copy ON solana_orders (copy_wallet, token) WHERE copy_wallet IS NOT NULL AND state = 'open';
CREATE INDEX meme_orders_copy ON meme_orders (chain, copy_wallet, token) WHERE copy_wallet IS NOT NULL AND state = 'open';

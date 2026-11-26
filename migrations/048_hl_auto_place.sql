-- Where a user with Hyperliquid automatic trading was last seen (compliance/regions.js): RektBull's servers send
-- automatic orders, so the venue can't check where the user is. An automatic open isn't sent while this is a
-- blocked place; closing always works. Recorded when automatic trading is switched on and on each visit.
ALTER TABLE hl_auto_grants ADD COLUMN country TEXT, ADD COLUMN seen_at TIMESTAMPTZ;

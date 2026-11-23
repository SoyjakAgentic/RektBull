-- Meme Watch on Solana, streamed (src/services/insiderWatch.js): each time a launch-bundle group's wallets,
-- together, hold less of the coin after a transaction (a sale, or a transfer out of the group), seen on the
-- Yellowstone stream within seconds. Moves between a group's own wallets cancel out and aren't recorded.
CREATE TABLE solana_insider_sells (
  signature   TEXT NOT NULL,
  mint        TEXT NOT NULL,
  funder      TEXT NOT NULL,            -- the wallet that funded the group (its id in Meme Watch's snapshot)
  sold_raw    NUMERIC NOT NULL,         -- what left the group in this transaction, in the mint's smallest units
  slot        BIGINT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (signature, mint, funder)
);
CREATE INDEX solana_insider_sells_group ON solana_insider_sells (mint, funder, at);

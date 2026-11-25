-- Meme Watch on BNB Chain and Base, streamed (src/trade/memeStream.js): each transfer out of a launch-bundle group
-- the stream saw, once (its transaction and log index), for coins with open Meme Watch exits. What's gone counts
-- these, from when the stream started watching the group.
CREATE TABLE meme_insider_sells (
  chain      TEXT NOT NULL,
  token      TEXT NOT NULL,
  funder     TEXT NOT NULL,          -- the group: the wallet that funded it (launchSafety.js)
  wallet     TEXT NOT NULL,          -- the group's wallet that sent
  tx_hash    TEXT NOT NULL,
  log_index  INT NOT NULL,
  amount     NUMERIC(78, 0) NOT NULL,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, tx_hash, log_index)
);
CREATE INDEX meme_insider_sells_group ON meme_insider_sells (chain, token, funder);

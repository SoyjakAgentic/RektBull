-- Private submission of the order services' fills (src/trade/privateSend.js, docs/PRIVATE_SEND.md).
-- raw_tx is the signed transaction (nothing secret in it), kept so one sent privately that hasn't landed can be
-- sent the usual way too, even after a restart. On BNB Chain the executor's nonce is tracked here, since a privacy
-- RPC's transactions aren't in the public mempool the chain's own RPC counts.
ALTER TABLE meme_order_fills
  ADD COLUMN nonce     BIGINT,
  ADD COLUMN raw_tx    TEXT,
  ADD COLUMN sent_via  TEXT NOT NULL DEFAULT 'public' CHECK (sent_via IN ('public', 'private')),
  ADD COLUMN relays    TEXT[],
  ADD COLUMN public_at TIMESTAMPTZ;

ALTER TABLE solana_order_fills
  ADD COLUMN raw_tx    TEXT,
  ADD COLUMN sent_via  TEXT NOT NULL DEFAULT 'public' CHECK (sent_via IN ('public', 'jito')),
  ADD COLUMN tip       BIGINT,
  ADD COLUMN public_at TIMESTAMPTZ;

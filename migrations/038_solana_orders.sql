-- Solana orders (src/trade/solanaOrders.js, docs/SOLANA_ORDERS.md): stop-losses, take-profits and
-- Meme Watch exits the user places in the order program and RektBull's executor fills. The order
-- itself lives onchain (order_address); this keeps what RektBull watches it for. Amounts are raw
-- units: the coin's for amount_in and filled_in, lamports for the rest.
CREATE TABLE solana_orders (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner         TEXT NOT NULL,          -- the user's Solana wallet
  order_address TEXT NOT NULL UNIQUE,   -- the order account: ["order", owner, nonce] under the program
  program       TEXT NOT NULL,
  nonce         NUMERIC(20, 0) NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('stop_loss', 'take_profit', 'meme_watch_exit')),
  token         TEXT NOT NULL,          -- the coin sold
  symbol        TEXT,
  token_program TEXT NOT NULL,
  decimals      SMALLINT NOT NULL,
  source        TEXT NOT NULL,          -- the user's token account it sells from
  amount_in     NUMERIC(39, 0) NOT NULL,
  min_out       NUMERIC(39, 0) NOT NULL, -- the user's floor: the least, after the fee, for all of amount_in
  trigger_out   NUMERIC(39, 0),          -- what all of amount_in must be worth for it to fire (none for Meme Watch exits)
  ref_out       NUMERIC(39, 0) NOT NULL, -- what all of amount_in would sell for when placed (Jupiter)
  executor      TEXT NOT NULL,
  valid_until   TIMESTAMPTZ NOT NULL,
  state         TEXT NOT NULL DEFAULT 'prepared'
                CHECK (state IN ('prepared', 'open', 'triggered', 'filled', 'cancelled', 'expired')),
  filled_in     NUMERIC(39, 0) NOT NULL DEFAULT 0,
  delivered     NUMERIC(39, 0) NOT NULL DEFAULT 0, -- SOL that reached the user from fills
  triggered_at  TIMESTAMPTZ,
  trigger_reason JSONB,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  last_error    TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX solana_orders_live ON solana_orders (state, kind) WHERE state IN ('prepared', 'open', 'triggered');
CREATE INDEX solana_orders_account ON solana_orders (account_id, created_at DESC);
CREATE INDEX solana_orders_token ON solana_orders (token) WHERE state IN ('open', 'triggered');

-- Each fill the executor sent: one transaction, recorded before it's sent.
CREATE TABLE solana_order_fills (
  id           BIGSERIAL PRIMARY KEY,
  order_id     BIGINT NOT NULL REFERENCES solana_orders(id) ON DELETE CASCADE,
  signature    TEXT NOT NULL UNIQUE,
  amount_in    NUMERIC(39, 0) NOT NULL,
  quoted_out   NUMERIC(39, 0),
  delivered    NUMERIC(39, 0),
  fee          NUMERIC(39, 0),
  route        TEXT,
  state        TEXT NOT NULL DEFAULT 'sent' CHECK (state IN ('sent', 'confirmed', 'failed')),
  error        TEXT,
  last_valid_block_height BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);
CREATE INDEX solana_order_fills_sent ON solana_order_fills (order_id) WHERE state = 'sent';

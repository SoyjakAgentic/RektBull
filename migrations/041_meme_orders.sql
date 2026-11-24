-- Orders on BNB Chain and Base (src/trade/memeOrders.js, docs/MEME_ROUTER.md): limit buys, stop-losses,
-- take-profits and Meme Watch exits the user signs (EIP-712) and RektBull's executor fills through the Meme
-- Router. The signed order is kept whole (order_json), so a fill sends exactly what the user signed. Amounts are
-- raw units: the input token's for amount_in and filled_in, the output's for min_out, trigger_out, ref_out
-- and delivered.
CREATE TABLE meme_orders (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chain         TEXT NOT NULL CHECK (chain IN ('base', 'bsc')),
  chain_id      INT NOT NULL,
  router        TEXT NOT NULL,
  owner         TEXT NOT NULL,          -- the user's wallet: the order's account
  kind          TEXT NOT NULL CHECK (kind IN ('stop_loss', 'take_profit', 'meme_watch_exit', 'limit_buy')),
  token         TEXT NOT NULL,          -- the meme coin, sold or bought
  symbol        TEXT,
  decimals      SMALLINT NOT NULL,
  token_in      TEXT NOT NULL,
  token_out     TEXT NOT NULL,          -- 0xeeee… for the native coin
  amount_in     NUMERIC(78, 0) NOT NULL,
  min_out       NUMERIC(78, 0) NOT NULL, -- the user's price: the least, after the fee, for all of amount_in
  trigger_out   NUMERIC(78, 0),          -- what all of amount_in must be worth (or buy) to fire; none for Meme Watch exits
  ref_out       NUMERIC(78, 0) NOT NULL, -- what all of amount_in would sell for (or buy) when placed
  executor      TEXT NOT NULL,
  valid_until   TIMESTAMPTZ NOT NULL,
  order_json    JSONB NOT NULL,          -- the order as signed (memeOrderTx.toJson)
  order_hash    TEXT NOT NULL UNIQUE,    -- its EIP-712 hash, as the router computes it
  signature     TEXT,
  spend_usd     NUMERIC,                 -- a limit buy's spend in USD when placed, against the per-trade amount
  state         TEXT NOT NULL DEFAULT 'prepared'
                CHECK (state IN ('prepared', 'open', 'triggered', 'filled', 'cancelled', 'expired')),
  filled_in     NUMERIC(78, 0) NOT NULL DEFAULT 0,
  delivered     NUMERIC(78, 0) NOT NULL DEFAULT 0,
  triggered_at  TIMESTAMPTZ,
  trigger_reason JSONB,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  last_error    TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX meme_orders_live ON meme_orders (state, kind) WHERE state IN ('prepared', 'open', 'triggered');
CREATE INDEX meme_orders_account ON meme_orders (account_id, created_at DESC);
CREATE INDEX meme_orders_token ON meme_orders (chain, token) WHERE state IN ('open', 'triggered');

-- Each fill the executor sent: one transaction, recorded before it's broadcast.
CREATE TABLE meme_order_fills (
  id           BIGSERIAL PRIMARY KEY,
  order_id     BIGINT NOT NULL REFERENCES meme_orders(id) ON DELETE CASCADE,
  tx_hash      TEXT NOT NULL UNIQUE,
  amount_in    NUMERIC(78, 0) NOT NULL,
  quoted_out   NUMERIC(78, 0),
  delivered    NUMERIC(78, 0),
  fee          NUMERIC(78, 0),
  fee_on_output BOOLEAN,
  route        TEXT,
  state        TEXT NOT NULL DEFAULT 'sent' CHECK (state IN ('sent', 'confirmed', 'failed')),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);
CREATE INDEX meme_order_fills_sent ON meme_order_fills (order_id) WHERE state = 'sent';

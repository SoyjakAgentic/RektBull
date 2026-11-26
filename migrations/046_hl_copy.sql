-- Copy trading on Hyperliquid perps (src/hyperliquid/copy.js, docs/HYPERLIQUID.md "Copy trading").
-- A follower's copies are automatic orders (hl_auto_intents) that RektBull decides (source 'agent').

-- One user following one trader, with the follower's own size, leverage cap and stop-loss on every copy.
CREATE TABLE hl_copy_follows (
  id              UUID PRIMARY KEY,
  account_id      BIGINT NOT NULL REFERENCES accounts(id),
  leader          TEXT NOT NULL CHECK (leader ~ '^0x[0-9a-f]{40}$'), -- the trader's Hyperliquid account
  trade_usd       NUMERIC NOT NULL CHECK (trade_usd > 0),              -- each copied open's size (notional)
  max_leverage    INTEGER NOT NULL CHECK (max_leverage BETWEEN 1 AND 50),
  stop_loss_pct   NUMERIC NOT NULL CHECK (stop_loss_pct > 0),          -- every copy carries the follower's own stop
  take_profit_pct NUMERIC,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  stop_reason     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX hl_copy_follows_one ON hl_copy_follows (account_id, leader) WHERE status = 'active';
CREATE INDEX hl_copy_follows_leader ON hl_copy_follows (leader) WHERE status = 'active';

-- Each watched trader: when they were last read. Their first read is the starting point, never copied.
CREATE TABLE hl_copy_leaders (
  leader      TEXT PRIMARY KEY,
  read_at     TIMESTAMPTZ,              -- the last read that succeeded
  checked_at  TIMESTAMPTZ,              -- the last attempt
  error       TEXT                      -- why the last attempt failed (a failed read is never taken as a close)
);

-- What each watched trader held at the last read: a new market or a flip is an open, a market gone or flipped a close.
CREATE TABLE hl_copy_leader_positions (
  leader    TEXT NOT NULL REFERENCES hl_copy_leaders(leader),
  coin      TEXT NOT NULL,
  side      TEXT NOT NULL CHECK (side IN ('long', 'short')),
  size      NUMERIC NOT NULL,
  entry_px  NUMERIC,
  leverage  INTEGER,
  PRIMARY KEY (leader, coin)
);

-- Each trade copied (or not) for a follower: only positions copying opened are closed when the trader closes.
CREATE TABLE hl_copy_trades (
  id           UUID PRIMARY KEY,
  follow_id    UUID NOT NULL REFERENCES hl_copy_follows(id),
  coin         TEXT NOT NULL,
  side         TEXT NOT NULL CHECK (side IN ('long', 'short')),
  leader_entry_px NUMERIC,
  status       TEXT NOT NULL CHECK (status IN ('open', 'closed', 'skipped')),
  reason       TEXT,                    -- why it was skipped, or how it ended
  open_intent  UUID REFERENCES hl_auto_intents(id),
  close_intent UUID REFERENCES hl_auto_intents(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX hl_copy_trades_one_open ON hl_copy_trades (follow_id, coin) WHERE status = 'open';
CREATE INDEX hl_copy_trades_follow ON hl_copy_trades (follow_id, created_at DESC);

ALTER TABLE hl_auto_intents ADD COLUMN follow_id UUID REFERENCES hl_copy_follows(id);

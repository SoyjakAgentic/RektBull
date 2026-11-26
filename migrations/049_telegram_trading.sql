-- Hyperliquid perps from Telegram (src/telegram/perps.js, docs/HYPERLIQUID.md "From Telegram").

-- "Trade from Telegram": off until the user switches it on from the Perps page (signed in with their wallet).
CREATE TABLE telegram_trading (
  account_id  BIGINT PRIMARY KEY REFERENCES accounts(id),
  enabled     BOOLEAN NOT NULL DEFAULT false,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An open asked for in Telegram, waiting for a tap on Confirm: good for 60 seconds, used once.
CREATE TABLE telegram_pending (
  id          TEXT PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  chat_id     TEXT NOT NULL,
  input       JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The chat an automatic order from Telegram reports back to.
ALTER TABLE hl_auto_intents ADD COLUMN notify_chat TEXT;

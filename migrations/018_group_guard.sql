-- Group Guard: the Telegram groups that added RektBull's bot, their settings,
-- and daily counts of what it did. No message text and no sender is stored.
CREATE TABLE guard_groups (
  chat_id     TEXT PRIMARY KEY,
  title       TEXT,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  settings    JSONB NOT NULL DEFAULT '{}',    -- official_sites, official_contracts, chains
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE guard_counts (
  chat_id  TEXT NOT NULL,
  day      DATE NOT NULL DEFAULT CURRENT_DATE,
  kind     TEXT NOT NULL,                     -- links_checked, phishing_removed, lookalike_warned, contract_warned, token_warned, impersonator_flagged, replies
  n        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, day, kind)
);

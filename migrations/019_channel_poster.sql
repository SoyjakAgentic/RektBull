-- Channel Poster: the Telegram channels that added RektBull's bot to draft
-- posts, who may approve them, and each draft (posted only on approval).
CREATE TABLE poster_channels (
  chat_id        TEXT PRIMARY KEY,
  title          TEXT,
  owner_user_id  TEXT NOT NULL,                -- the admin who added the bot; drafts go to them
  enabled        BOOLEAN NOT NULL DEFAULT true,
  settings       JSONB NOT NULL DEFAULT '{}',  -- topics, chains, snapshot_space, protocol_slug, baselined
  added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at     TIMESTAMPTZ
);
CREATE INDEX poster_channels_owner ON poster_channels (owner_user_id);

CREATE TABLE poster_drafts (
  id           BIGSERIAL PRIMARY KEY,
  chat_id      TEXT NOT NULL REFERENCES poster_channels(chat_id) ON DELETE CASCADE,
  key          TEXT NOT NULL,                  -- the item it's about, so nothing is drafted twice
  topic        TEXT NOT NULL,
  text         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'skipped', 'expired', 'baseline')),
  sent_at      TIMESTAMPTZ,                    -- when it was sent to the owner to approve
  decided_at   TIMESTAMPTZ,
  decided_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, key)
);
CREATE INDEX poster_drafts_pending ON poster_drafts (status, created_at) WHERE status = 'pending';

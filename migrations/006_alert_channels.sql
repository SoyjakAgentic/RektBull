-- Where an account's alerts go: Telegram, email, browser push. A channel
-- counts only once it's verified (Telegram: the user started the bot with a
-- one-time code; email: the user clicked the confirmation link; push: the
-- browser gave a subscription).
CREATE TABLE alert_channels (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  kind         TEXT NOT NULL CHECK (kind IN ('telegram', 'email', 'push')),
  target       TEXT NOT NULL,                  -- chat id, email address, or the push subscription (JSON)
  label        TEXT,                           -- what to show the user: @name, the address, the browser
  min_severity TEXT NOT NULL DEFAULT 'medium' CHECK (min_severity IN ('critical', 'high', 'medium', 'low', 'info')),
  verified_at  TIMESTAMPTZ,
  disabled_at  TIMESTAMPTZ,                    -- set when the channel stops working (bot blocked, push expired, unsubscribed)
  disabled_reason TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind, target)
);

-- One-time codes: linking Telegram, confirming an email.
CREATE TABLE alert_link_codes (
  code        TEXT PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  kind        TEXT NOT NULL,
  target      TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

-- One row per alert per channel: sent once, retried with backoff on failure.
CREATE TABLE alert_deliveries (
  id              BIGSERIAL PRIMARY KEY,
  alert_id        BIGINT NOT NULL REFERENCES monitor_alerts(id) ON DELETE CASCADE,
  channel_id      BIGINT NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  sent_at         TIMESTAMPTZ,
  UNIQUE (alert_id, channel_id)
);
CREATE INDEX alert_deliveries_due ON alert_deliveries (status, next_attempt_at);

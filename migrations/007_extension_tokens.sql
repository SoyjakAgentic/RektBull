-- Tokens the RektBull browser extension uses. Each is a signed JWT with
-- scope 'extension' (it can only run pre-sign checks and read monitor
-- alerts), listed here so the user can see and revoke it.
CREATE TABLE extension_tokens (
  jti          TEXT PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX extension_tokens_account ON extension_tokens (account_id);

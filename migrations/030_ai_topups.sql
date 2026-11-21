-- Safety Pro AI top-ups (docs/PAYMENTS.md): AI usage bought on top of the
-- pass's 30-day allowance, paid with credits or RektBull Points. Dollar for
-- dollar, at what each AI run actually costs RektBull; used only once the
-- 30-day allowance is used up; never expires. Positive rows are top-ups,
-- negative rows AI runs (and AI proposals) paid from them.
CREATE TABLE ai_topups (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  usd         NUMERIC(14, 6) NOT NULL CHECK (usd <> 0),
  kind        TEXT NOT NULL CHECK (kind IN ('topup', 'use')),
  paid_with   TEXT CHECK (paid_with IN ('credits', 'points')),
  ref         TEXT NOT NULL UNIQUE,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ai_topups_account ON ai_topups (account_id, created_at DESC);

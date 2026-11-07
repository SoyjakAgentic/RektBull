-- Safety Pro's AI allowance: what each account's AI runs cost in each
-- 30-day period of its pass (src/payments/aiAllowance.js), and what each run
-- cost in AI, so the margin can be read rather than guessed.
CREATE TABLE ai_allowance_usage (
  account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period      TEXT NOT NULL,                   -- pass:<pass id>:<30-day period index>
  used_usd    NUMERIC(12, 6) NOT NULL DEFAULT 0,
  runs        INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, period)
);

ALTER TABLE runs ADD COLUMN ai_cost_usd NUMERIC(12, 6);

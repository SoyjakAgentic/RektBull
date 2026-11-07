-- AI agents: each account's switch, schedule and settings for each agent,
-- and what the agent's last run saw (to compare with the next).
-- An agent with no row here runs with its defaults (agents that were already
-- running before this table, like the risk monitor, stay on).
CREATE TABLE agent_settings (
  account_id   BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agent        TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL,
  every_hours  INTEGER,                        -- NULL: the agent's default
  settings     JSONB NOT NULL DEFAULT '{}',    -- e.g. the tokens a watch list holds
  snapshot     JSONB,                          -- what the last run saw
  last_run_at  TIMESTAMPTZ,
  last_result  JSONB,                          -- a short summary of the last run, shown on the page
  last_error   TEXT,
  next_run_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, agent)
);
CREATE INDEX agent_settings_due ON agent_settings (next_run_at) WHERE enabled;

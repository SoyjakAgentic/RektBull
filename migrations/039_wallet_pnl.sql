-- Wallets ranked by realised profit (src/services/walletRankings.js): per wallet and UTC day, the sums of
-- what it realised on pump.fun's bonding curves, read from the stream. Public onchain facts about wallets,
-- not tied to an account; deleted after 35 days (src/privacy/retention.js). Amounts in lamports.
CREATE TABLE wallet_pnl_daily (
  chain      TEXT NOT NULL,
  wallet     TEXT NOT NULL,
  day        DATE NOT NULL,
  realised   BIGINT NOT NULL DEFAULT 0, -- SOL back from sales, less what those parts cost (fees included)
  cost       BIGINT NOT NULL DEFAULT 0, -- what the sold parts cost
  proceeds   BIGINT NOT NULL DEFAULT 0,
  coins      INT NOT NULL DEFAULT 0,    -- positions closed (99% sold)
  wins       INT NOT NULL DEFAULT 0,
  losses     INT NOT NULL DEFAULT 0,
  snipes     INT NOT NULL DEFAULT 0,    -- closed positions bought within seconds of the coin's creation (not counted above)
  best       BIGINT NOT NULL DEFAULT 0, -- the most one closed position made
  trades     INT NOT NULL DEFAULT 0,    -- trades seen that day (for the bot rule)
  bot        BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, wallet, day)
);
CREATE INDEX wallet_pnl_daily_day ON wallet_pnl_daily (chain, day);

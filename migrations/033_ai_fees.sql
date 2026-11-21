-- AI fees (docs/AI_PROPOSALS.md): offering a proposal is free and acting on it is charged, so a proposal
-- has no payment until the user approves it. Orders prepared from a proposal name it (polymarket_orders.rule_id).
ALTER TABLE ai_proposals ALTER COLUMN paid_from DROP NOT NULL;

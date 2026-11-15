-- Sign in with Solana (Trade desk, stage 2). An account is now an EVM wallet, a Solana wallet, or both:
-- it signs in with either and links the other by signing with it. `wallet` stays the lowercase 0x
-- address (NULL for an account that only has a Solana wallet); `solana_wallet` is the base58 address,
-- case kept (Solana addresses are case-sensitive).

ALTER TABLE accounts ALTER COLUMN wallet DROP NOT NULL;
ALTER TABLE accounts ADD COLUMN solana_wallet TEXT UNIQUE;
ALTER TABLE accounts ADD CONSTRAINT accounts_has_a_wallet CHECK (wallet IS NOT NULL OR solana_wallet IS NOT NULL);

-- A challenge is for signing in (link_account_id NULL) or for linking a wallet to that account.
ALTER TABLE siwe_challenges ADD COLUMN kind TEXT NOT NULL DEFAULT 'evm' CHECK (kind IN ('evm', 'solana'));
ALTER TABLE siwe_challenges ADD COLUMN link_account_id BIGINT REFERENCES accounts(id) ON DELETE CASCADE;

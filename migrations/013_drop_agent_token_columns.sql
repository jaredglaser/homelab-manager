-- Drop agent token columns from managed_hosts.
-- Tokens are now stored in OpenBao at secret/hosts/<hostname>/agent_token.
ALTER TABLE managed_hosts DROP COLUMN IF EXISTS agent_token;
ALTER TABLE managed_hosts DROP COLUMN IF EXISTS agent_token_hash;

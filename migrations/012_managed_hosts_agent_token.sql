-- Add agent_token column to managed_hosts for worker authentication.
-- The worker needs the plaintext token to authenticate against agent containers.
ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_token TEXT;

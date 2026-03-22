-- migrations/018_agent_token_transit.sql
-- Add Transit-encrypted column for agent tokens

ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_token_encrypted TEXT;

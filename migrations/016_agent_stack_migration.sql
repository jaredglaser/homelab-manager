-- 016_agent_stack_migration.sql
-- Drop socket_proxy_url (socket proxy now lives inside agent stack)
-- Add capabilities JSONB column for feature detection
ALTER TABLE managed_hosts
  DROP COLUMN IF EXISTS socket_proxy_url,
  ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{}';

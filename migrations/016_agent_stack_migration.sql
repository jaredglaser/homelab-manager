-- 016_agent_stack_migration.sql
-- Drop socket_proxy_url (socket proxy now lives inside agent stack)
-- Add capabilities JSONB column for feature detection

-- Preserve Docker capability for existing hosts before dropping socket_proxy_url
ALTER TABLE managed_hosts
  ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{}';

UPDATE managed_hosts
  SET capabilities = jsonb_set(capabilities, '{docker}', 'true')
  WHERE capabilities = '{}';

ALTER TABLE managed_hosts
  DROP COLUMN IF EXISTS socket_proxy_url;

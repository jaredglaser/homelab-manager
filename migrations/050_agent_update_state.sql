-- migrations/050_agent_update_state.sql
-- The last agent update the dashboard ran on this host. All three NULL means none has run since this migration.
-- agent_update_at is when a running update started, or when a finished or interrupted one ended.

ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_update_state TEXT;
ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_update_result JSONB;
ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_update_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'managed_hosts_agent_update_check'
  ) THEN
    ALTER TABLE managed_hosts ADD CONSTRAINT managed_hosts_agent_update_check
      CHECK (
        (agent_update_state IS NULL AND agent_update_result IS NULL AND agent_update_at IS NULL)
        OR (agent_update_state IN ('running', 'interrupted', 'errored') AND agent_update_result IS NULL AND agent_update_at IS NOT NULL)
        OR (agent_update_state = 'done' AND agent_update_result IS NOT NULL AND agent_update_at IS NOT NULL)
      );
  END IF;
END
$$;

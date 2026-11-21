-- migrations/045_managed_hosts_failure.sql
-- NULL in both columns means the last probe succeeded or the host was never probed.

ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS failure_code TEXT;
ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS failure_detail TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'managed_hosts_failure_check'
  ) THEN
    ALTER TABLE managed_hosts ADD CONSTRAINT managed_hosts_failure_check
      CHECK (
        (failure_code IS NULL OR failure_code IN ('offline', 'unreachable', 'awaiting-enrollment', 'agent-unhealthy', 'certificate-rejected', 'health_check_failed'))
        AND (failure_detail IS NULL OR failure_code IS NOT NULL)
        AND (status <> 'healthy' OR failure_code IS NULL)
      );
  END IF;
END
$$;

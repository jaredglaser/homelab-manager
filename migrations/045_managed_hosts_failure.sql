-- migrations/045_managed_hosts_failure.sql
-- Why the last probe of this host failed, plus the probe's own detail, so the
-- Agents card can name the cause and the next step instead of re-deriving a
-- coarser status from managed_hosts.status. The sweep classifies every failure
-- as offline (nothing answered at the network level), unreachable (something
-- answered that is not a healthy agent) or awaiting-enrollment (the agent serves
-- plain HTTP until it holds a certificate); health_check_failed covers a probe
-- that failed without naming a reason. NULL in both columns means the last probe
-- succeeded, or the host has never been probed. A healthy status cannot carry a
-- cause, and a detail cannot outlive the code it explains.

ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS failure_code TEXT;
ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS failure_detail TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'managed_hosts_failure_check'
  ) THEN
    ALTER TABLE managed_hosts ADD CONSTRAINT managed_hosts_failure_check
      CHECK (
        (failure_code IS NULL OR failure_code IN ('offline', 'unreachable', 'awaiting-enrollment', 'health_check_failed'))
        AND (failure_detail IS NULL OR failure_code IS NOT NULL)
        AND (status <> 'healthy' OR failure_code IS NULL)
      );
  END IF;
END
$$;

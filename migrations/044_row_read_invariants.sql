-- A NULL value is deleted, never filled: getLinkedContainerIds joins service_key rows on value equality, so a shared placeholder would link unrelated containers.
-- A NULL status becomes unhealthy, never pending: handleRotateHostTls allows plaintext enrollment for a pending host, and the next sweep corrects unhealthy.

DO $$
DECLARE
  affected BIGINT;
BEGIN
  DELETE FROM entity_metadata WHERE value IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE NOTICE '044: deleted % entity_metadata row(s) with a NULL value', affected;
  END IF;

  UPDATE managed_hosts SET status = 'unhealthy' WHERE status IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE NOTICE '044: set % managed_hosts row(s) with a NULL status to unhealthy', affected;
  END IF;
END
$$;

ALTER TABLE managed_hosts ALTER COLUMN status SET NOT NULL;

ALTER TABLE entity_metadata ALTER COLUMN value SET NOT NULL;

-- 'restart' ran `docker compose restart` (no pull, no recreate) before #167 removed it, so 'deploy' is the nearest label.
UPDATE deploy_history SET action = 'deploy' WHERE action = 'restart';

ALTER TABLE deploy_history DROP CONSTRAINT IF EXISTS deploy_history_action_check;
ALTER TABLE deploy_history ADD CONSTRAINT deploy_history_action_check
  CHECK (action IN ('deploy', 'teardown', 'update'));

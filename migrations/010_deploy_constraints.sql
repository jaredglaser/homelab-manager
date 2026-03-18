-- Make timestamps non-nullable
ALTER TABLE managed_hosts
  ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE deploy_history
  ALTER COLUMN created_at SET NOT NULL;

-- Foreign key: deploy_history.host must reference a managed_hosts.name
ALTER TABLE deploy_history
  ADD CONSTRAINT fk_deploy_history_host
  FOREIGN KEY (host) REFERENCES managed_hosts(name);

-- Enforce valid deploy statuses at the database level
ALTER TABLE deploy_history
  ADD CONSTRAINT valid_status
  CHECK (status IN ('pending', 'in_progress', 'succeeded', 'failed', 'no_change'));

-- Enforce valid managed_hosts statuses
ALTER TABLE managed_hosts
  ADD CONSTRAINT valid_host_status
  CHECK (status IN ('pending', 'healthy', 'unhealthy', 'error'));

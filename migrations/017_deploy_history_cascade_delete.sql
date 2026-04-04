-- Add ON DELETE CASCADE to deploy_history FK so host removal cleans up history
ALTER TABLE deploy_history
  DROP CONSTRAINT fk_deploy_history_host,
  ADD CONSTRAINT fk_deploy_history_host
    FOREIGN KEY (host) REFERENCES managed_hosts(name) ON DELETE CASCADE;

-- Rollback:
-- ALTER TABLE deploy_history
--   DROP CONSTRAINT fk_deploy_history_host,
--   ADD CONSTRAINT fk_deploy_history_host
--     FOREIGN KEY (host) REFERENCES managed_hosts(name);

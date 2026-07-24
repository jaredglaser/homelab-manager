-- Add 'update' to the allowed deploy_history actions (image refresh via
-- docker compose pull + up, distinct from a plain deploy which never pulls).
ALTER TABLE deploy_history DROP CONSTRAINT IF EXISTS deploy_history_action_check;

ALTER TABLE deploy_history ADD CONSTRAINT deploy_history_action_check
  CHECK (action IN ('deploy', 'teardown', 'restart', 'update'));

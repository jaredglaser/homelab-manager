-- A value outside this set makes DeployRepository.toDeployRecord throw, which fails every deploy-history read.
ALTER TABLE deploy_history DROP CONSTRAINT IF EXISTS deploy_history_trigger_check;
ALTER TABLE deploy_history ADD CONSTRAINT deploy_history_trigger_check
  CHECK (trigger IN ('git_push', 'ui', 'manual_rollback'));

ALTER TABLE deploy_history DROP CONSTRAINT IF EXISTS deploy_history_post_success_check;
ALTER TABLE deploy_history ADD CONSTRAINT deploy_history_post_success_check
  CHECK (post_success IS NULL OR post_success IN ('removeFromManifest'));

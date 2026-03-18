-- Prevent concurrent active deploys for the same stack+host.
-- Only one row with status 'pending' or 'in_progress' may exist per (stack, host).
CREATE UNIQUE INDEX IF NOT EXISTS idx_deploy_one_active_per_stack_host
  ON deploy_history (stack, host)
  WHERE status IN ('pending', 'in_progress');

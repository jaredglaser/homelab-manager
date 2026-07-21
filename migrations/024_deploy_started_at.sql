-- Track when a deploy actually began running (transitioned to in_progress),
-- distinct from created_at (set when the row was inserted, which for a
-- manual-approval deploy can be long before it starts). The watchdog ages
-- in_progress deploys by this timestamp so a deploy approved well after
-- creation is not failed the instant it starts running, which would also
-- wrongly release the one-active-deploy-per-stack-host guard.
ALTER TABLE deploy_history ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

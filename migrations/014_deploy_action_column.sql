-- Add action column to track what kind of deploy operation was performed
ALTER TABLE deploy_history ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'deploy';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deploy_history_action_check'
  ) THEN
    ALTER TABLE deploy_history ADD CONSTRAINT deploy_history_action_check
      CHECK (action IN ('deploy', 'teardown', 'restart'));
  END IF;
END
$$;

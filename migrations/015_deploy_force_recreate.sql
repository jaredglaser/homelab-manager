-- Track whether a deploy used force recreate
ALTER TABLE deploy_history ADD COLUMN IF NOT EXISTS force_recreate BOOLEAN NOT NULL DEFAULT false;

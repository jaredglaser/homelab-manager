-- Add action column to track what kind of deploy operation was performed
ALTER TABLE deploy_history ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'deploy';

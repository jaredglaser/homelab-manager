-- Add post_success column to deploy_history so the pipeline can execute a
-- post-completion hook (e.g. remove stack from manifest) after a successful
-- teardown without blocking the HTTP request that triggered it.
ALTER TABLE deploy_history ADD COLUMN post_success TEXT NULL;

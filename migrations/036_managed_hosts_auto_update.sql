-- migrations/035_managed_hosts_auto_update.sql
-- Per-agent opt-in for automatic updates. Manual by default: an agent with
-- auto_update = false (or NULL from before this column existed) never checks
-- for or applies updates on its own; only the manager's per-host manual
-- update action updates it.

ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS auto_update BOOLEAN NOT NULL DEFAULT false;

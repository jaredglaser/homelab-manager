-- migrations/035_managed_hosts_last_swept_at.sql
-- When the agent inventory sweep last probed this host. Kept distinct from
-- updated_at because every writer to managed_hosts bumps that column (rename,
-- URL edit, key rotation, a single-host health check), so updated_at cannot
-- answer "when was this agent last checked" and made the inventory report a
-- fresher sweep than actually ran. NULL means the host has never been swept.

ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS last_swept_at TIMESTAMPTZ;

-- migrations/040_agent_image_digest.sql
-- Digest of the image the agent container itself runs, reported by the agent's
-- /info and persisted by the inventory sweep, plus the sweep-computed verdict
-- against the manager's own agent image digest. NULL covers ZFS-only hosts with
-- no Docker socket and agents predating digest reporting. Replaces the
-- agent-updater sidecar columns from migration 036; the sidecar is removed and
-- agent updates are detected from the agent's own image instead.

ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_image_digest TEXT;
ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_out_of_date BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE managed_hosts DROP COLUMN IF EXISTS agent_updater_image_digest;
ALTER TABLE managed_hosts DROP COLUMN IF EXISTS agent_updater_image_tag;
ALTER TABLE managed_hosts DROP COLUMN IF EXISTS agent_updater_out_of_date;

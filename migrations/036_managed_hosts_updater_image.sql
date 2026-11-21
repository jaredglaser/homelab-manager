-- migrations/036_managed_hosts_updater_image.sql
-- What each host's agent-updater sidecar runs, collected by the agent inventory
-- sweep from the agent's /info, plus the sweep-computed verdict. The digest lets
-- the UI flag a sidecar older than the manager's own updater image (a self
-- out of date sidecar cannot be updated remotely); NULL covers ZFS-only hosts
-- with no sidecar and agents predating updater reporting.

ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_updater_image_digest TEXT;
ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_updater_image_tag TEXT;
ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_updater_out_of_date BOOLEAN NOT NULL DEFAULT FALSE;

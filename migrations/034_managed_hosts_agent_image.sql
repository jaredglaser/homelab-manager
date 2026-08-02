-- migrations/034_managed_hosts_agent_image.sql
-- Image reference and tag each agent reports from /info, so Settings can tell a
-- host running the :dev agent apart from one running :latest. Both stay NULL for
-- hosts whose agent predates image reporting, and NULL is also what a reporting
-- agent sends when it cannot determine its own image (no AGENT_IMAGE set and no
-- Docker socket to inspect itself through), so "unknown" and "not yet checked"
-- are the same state here.

ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_image TEXT;
ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_image_tag TEXT;

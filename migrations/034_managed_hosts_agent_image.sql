-- migrations/034_managed_hosts_agent_image.sql
-- Image reference and tag each agent reports from /info, so Settings can tell a host
-- running the :dev agent apart from one running :latest. NULL covers both "agent
-- predates image reporting" and "agent could not determine its own image".

ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_image TEXT;
ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_image_tag TEXT;

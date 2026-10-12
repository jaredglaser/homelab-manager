-- Backfill entity_metadata registration for container IDs that recorded stats
-- but were never registered: the service_key row that the history fan-out
-- joins on is written only when a stats frame arrives, so an incarnation born
-- during a worker/agent outage has history in docker_stats that the dashboard
-- cannot reach. Grouping the aggregate tiers by (host, container_name) links
-- every past ID that shares the name, with no manual backfill.
--
-- Sources are the _1m and _1h_avg tiers, not raw docker_stats: raw retention is
-- 24 hours, the minute tier holds 30 days and the hourly tier indefinitely.
-- service_key follows AgentStatsCollector's convention (container name, not
-- compose labels) so backfilled rows join with the rows the live collector
-- writes. Containers whose name changed across a recreate stay unlinked; that
-- matches the live convention and cannot be recovered from name grouping.
--
-- ON CONFLICT DO NOTHING: rows the collectors already wrote are never clobbered,
-- which also makes reruns and restarts harmless.

INSERT INTO entity_metadata (source, entity, key, value, updated_at)
SELECT
  'docker',
  s.host || '/' || s.container_id,
  k.key,
  CASE k.key WHEN 'image' THEN s.image ELSE s.container_name END,
  NOW()
FROM (
  SELECT DISTINCT ON (host, container_id)
    host, container_id, container_name, image
  FROM (
    SELECT host, container_id, container_name, image, time FROM docker_stats_1m
    UNION ALL
    SELECT host, container_id, container_name, image, time FROM docker_stats_1h_avg
  ) u
  WHERE container_name IS NOT NULL
  ORDER BY host, container_id, time DESC
) s
CROSS JOIN (VALUES ('name'), ('image'), ('service_key')) AS k(key)
WHERE k.key <> 'image' OR s.image IS NOT NULL
ON CONFLICT (source, entity, key) DO NOTHING;

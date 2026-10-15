-- Backfills entity_metadata for container IDs that have stats but no service_key
-- row: without it the history fan-out cannot reach those rows.
--
-- Invariants:
--   1. Sources are the _1m and _1h_avg tiers, never raw: raw retention is 24 hours,
--      the minute tier holds 30 days and the hourly tier indefinitely.
--   2. service_key is the container name, matching AgentStatsCollector's convention;
--      a compose-label key here would split the fan-out's join into two groups.
--      Containers whose name changed across a recreate stay unlinked.
--   3. ON CONFLICT DO NOTHING: rows the collectors already wrote are never clobbered,
--      which also makes reruns and restarts harmless.
--
--   038 later rewrites the name-based keys this inserts to the label-derived form.
--      The name convention here is no longer the fan-out's identity contract.

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

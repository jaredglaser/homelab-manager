-- Rewrites name-based entity_metadata service_key rows to the label-derived key
-- each container's newest docker_container_events upsert row carries. Destroy
-- rows carry a null key and are never a source. A container with no event rows
-- keeps its name-based key because nothing can derive its labels. Rows already
-- matching are untouched, so reruns write nothing. Icons are copied from the
-- old host/<key> entity to the new one. The target icon wins, and the old icon
-- row stays because a container that lost its events may still own that key.

WITH latest_events AS (
  SELECT DISTINCT ON (host, container_id)
    host, container_id, service_key
  FROM docker_container_events
  WHERE event_type = 'upsert' AND service_key IS NOT NULL
  ORDER BY host, container_id, at DESC
),
rewritten AS (
  SELECT
    sk.source,
    sk.entity,
    SPLIT_PART(sk.entity, '/', 1) AS host,
    sk.value AS old_key,
    le.service_key AS new_key
  FROM entity_metadata sk
  JOIN latest_events le
    ON le.host = SPLIT_PART(sk.entity, '/', 1)
   AND le.container_id = SPLIT_PART(sk.entity, '/', 2)
  WHERE sk.source = 'docker'
    AND sk.key = 'service_key'
    AND sk.value IS DISTINCT FROM le.service_key
),
moved_icons AS (
  INSERT INTO entity_metadata (source, entity, key, value, updated_at)
  SELECT r.source, r.host || '/' || r.new_key, 'icon', icon.value, NOW()
  FROM rewritten r
  JOIN entity_metadata icon
    ON icon.source = r.source
   AND icon.key = 'icon'
   AND icon.entity = r.host || '/' || r.old_key
  ON CONFLICT (source, entity, key) DO NOTHING
  RETURNING 1
),
rekeyed AS (
  UPDATE entity_metadata sk
  SET value = r.new_key, updated_at = NOW()
  FROM rewritten r
  WHERE sk.source = r.source
    AND sk.entity = r.entity
    AND sk.key = 'service_key'
  RETURNING 1
)
SELECT (SELECT count(*) FROM moved_icons) + (SELECT count(*) FROM rekeyed) AS rewrite_count;

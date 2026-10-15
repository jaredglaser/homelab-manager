-- Rewrites name-based service_key rows in entity_metadata to the label-derived
-- key the inventory collector now writes, so deployments upgraded in place keep
-- their container histories linked across recreations.
--
-- Invariants:
--   1. The derivation source is the newest docker_container_events row per
--      host/container_id that carries a service_key (the latest 'upsert'):
--      the event table is the only store that already holds the label-derived
--      key. Destroy rows carry a null service_key and are never a source.
--   2. Containers with no event row keep their name-based key: nothing in the
--      database can derive their labels.
--   3. Rows whose value already matches the latest event's key are untouched,
--      so a rerun updates nothing and inserts nothing.
--   4. Icons live under the host/service_key entity, so each rewritten key
--      moves its icon row from host/old_key to host/new_key, and only when the
--      target entity has no icon yet: an icon already set on the target wins.
--   5. Icon rows are copied, not moved: the row at host/old_key stays. A
--      container with no event row may still legitimately own that key, and
--      deleting the old row would orphan its icon.

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

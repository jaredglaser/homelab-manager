-- Rekeys image_update_checks from (host, image) to (host, stack, image): two
-- stacks sharing an image ref previously merged labels and shared one verdict.
-- manifest_digest lands here too: the etag-digest binding change needs both
-- columns live in the same boot. Each old row is expanded per stack that
-- currently runs the image, using the same latest-event-per-container snapshot
-- semantics as getCurrentSnapshot (docker-container-event-repository.ts).
-- Rows whose image no longer runs in any compose stack are dropped; the
-- refresher re-checks them within one interval (cost: one extra HEAD for a
-- floating tag, one live check for tag verdicts).

ALTER TABLE image_update_checks
  ADD COLUMN IF NOT EXISTS stack TEXT,
  ADD COLUMN IF NOT EXISTS manifest_digest TEXT;

WITH snapshot AS (
  SELECT DISTINCT ON (host, container_id)
    host, container_id, event_type, image, compose_project
  FROM docker_container_events
  ORDER BY host, container_id, at DESC
),
live AS (
  SELECT DISTINCT host, compose_project AS stack, image
  FROM snapshot
  WHERE event_type = 'upsert'
    AND compose_project IS NOT NULL
    AND image IS NOT NULL
)
INSERT INTO image_update_checks (
  host, image, stack,
  current_tag, latest_matching_tag, latest_overall_tag,
  update_available, source_repo, error, last_error_at,
  etag, checked_at, manifest_digest
)
SELECT
  old.host, old.image, live.stack,
  old.current_tag, old.latest_matching_tag, old.latest_overall_tag,
  old.update_available, old.source_repo, old.error, old.last_error_at,
  old.etag, old.checked_at,
  NULL
FROM image_update_checks old
JOIN live
  ON live.host = old.host AND live.image = old.image
WHERE old.stack IS NULL;

DELETE FROM image_update_checks WHERE stack IS NULL;

ALTER TABLE image_update_checks ALTER COLUMN stack SET NOT NULL;
ALTER TABLE image_update_checks DROP CONSTRAINT image_update_checks_pkey;
ALTER TABLE image_update_checks ADD PRIMARY KEY (host, stack, image);

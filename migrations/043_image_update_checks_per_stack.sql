-- Rekeys image_update_checks from (host, image) to (host, stack, image): two
-- stacks sharing an image ref previously merged labels and shared one verdict.
-- manifest_digest lands here too: the etag-digest binding change needs both
-- columns live in the same boot. Each old row is expanded per stack that
-- currently runs the image, using the same latest-event-per-container snapshot
-- semantics as getCurrentSnapshot (docker-container-event-repository.ts).
-- Rows whose image no longer runs in any compose stack are dropped; the
-- refresher re-checks them within one interval (cost: one extra HEAD for a
-- floating tag, one live check for tag verdicts).
--
-- The expansion builds a fresh table instead of ALTERing in place: while the
-- old (host, image) primary key exists, a row expanding into two stacks would
-- collide with its own source row.

CREATE TABLE image_update_checks_new (
  host TEXT NOT NULL,
  stack TEXT NOT NULL,
  image TEXT NOT NULL,
  current_tag TEXT,
  latest_matching_tag TEXT,
  latest_overall_tag TEXT,
  update_available BOOLEAN,
  source_repo TEXT,
  error TEXT,
  last_error_at TIMESTAMPTZ,
  etag TEXT,
  manifest_digest TEXT,
  checked_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (host, stack, image)
);

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
INSERT INTO image_update_checks_new (
  host, stack, image,
  current_tag, latest_matching_tag, latest_overall_tag,
  update_available, source_repo, error, last_error_at,
  etag, checked_at, manifest_digest
)
SELECT
  old.host, live.stack, old.image,
  old.current_tag, old.latest_matching_tag, old.latest_overall_tag,
  old.update_available, old.source_repo, old.error, old.last_error_at,
  old.etag, old.checked_at,
  NULL
FROM image_update_checks old
JOIN live
  ON live.host = old.host AND live.image = old.image;

DROP TABLE image_update_checks;
ALTER TABLE image_update_checks_new RENAME TO image_update_checks;

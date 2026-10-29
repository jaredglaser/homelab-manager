-- migrations/042_image_update_checks.sql
-- Persisted registry update state, one row per (host, image), written by the
-- scheduled refresher and read by the stacks panel. update_available NULL
-- means unknown (floating tag without a digest, digest pin, or failed check).
-- A failed check updates only the error columns and keeps the last known good
-- tag columns, so a registry outage never pins an error over good data.
CREATE TABLE IF NOT EXISTS image_update_checks (
  host TEXT NOT NULL,
  image TEXT NOT NULL,
  current_tag TEXT,
  latest_matching_tag TEXT,
  latest_overall_tag TEXT,
  update_available BOOLEAN,
  source_repo TEXT,
  error TEXT,
  last_error_at TIMESTAMPTZ,
  etag TEXT,
  checked_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (host, image)
);

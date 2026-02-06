-- Generic entity metadata table for storing key-value pairs per entity
-- Used for storing display names, labels, and other metadata that doesn't
-- belong in the time-series stats tables.

CREATE TABLE entity_metadata (
  source_id SMALLINT NOT NULL REFERENCES stat_source(id),
  entity VARCHAR(255) NOT NULL,
  key VARCHAR(128) NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, entity, key)
);

CREATE INDEX idx_entity_metadata_source_entity
  ON entity_metadata (source_id, entity);

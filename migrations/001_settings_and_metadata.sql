-- Settings and entity metadata tables for homelab-manager
-- Time-series data is stored in InfluxDB; PostgreSQL is used for
-- application settings and entity metadata only.

-- ============================================================================
-- APPLICATION SETTINGS
-- ============================================================================

-- Key-value store for application settings
-- Keys use path-style naming: 'docker/memoryDisplayMode'
CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(255) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- ENTITY METADATA
-- ============================================================================

-- Generic entity metadata table for storing key-value pairs per entity
-- Used for storing display names, labels, icons, and other metadata
-- that doesn't belong in the time-series database.
CREATE TABLE IF NOT EXISTS entity_metadata (
  source VARCHAR(64) NOT NULL,
  entity VARCHAR(255) NOT NULL,
  key VARCHAR(128) NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source, entity, key)
);

CREATE INDEX IF NOT EXISTS idx_entity_metadata_source_entity
  ON entity_metadata (source, entity);

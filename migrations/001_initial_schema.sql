-- Generic time-series schema for homelab-manager
-- Uses EAV (Entity-Attribute-Value) model for extensibility

-- ============================================================================
-- DIMENSION TABLES
-- ============================================================================

-- Data sources (e.g., 'docker', 'zfs')
CREATE TABLE stat_source (
  id SMALLINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name VARCHAR(64) NOT NULL UNIQUE
);

-- Metric types scoped to a source (e.g., docker/cpu_percent, zfs/read_ops_per_sec)
CREATE TABLE stat_type (
  id SMALLINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id SMALLINT NOT NULL REFERENCES stat_source(id),
  name VARCHAR(128) NOT NULL,
  UNIQUE(source_id, name)
);

-- ============================================================================
-- FACT TABLES
-- ============================================================================

-- Raw measurements (1-second granularity, 0-7 days retention)
CREATE TABLE stats_raw (
  timestamp TIMESTAMPTZ NOT NULL,
  source_id SMALLINT NOT NULL REFERENCES stat_source(id),
  type_id SMALLINT NOT NULL REFERENCES stat_type(id),
  entity VARCHAR(255) NOT NULL,
  value DOUBLE PRECISION NOT NULL
);

-- Aggregated measurements (minute/hour/day granularity)
CREATE TABLE stats_agg (
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  source_id SMALLINT NOT NULL REFERENCES stat_source(id),
  type_id SMALLINT NOT NULL REFERENCES stat_type(id),
  entity VARCHAR(255) NOT NULL,
  min_value DOUBLE PRECISION,
  avg_value DOUBLE PRECISION,
  max_value DOUBLE PRECISION,
  sample_count INT,
  granularity VARCHAR(10) NOT NULL CHECK (granularity IN ('minute', 'hour', 'day'))
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Raw table indexes
CREATE UNIQUE INDEX idx_stats_raw_unique
  ON stats_raw (timestamp, source_id, type_id, entity);

CREATE INDEX idx_stats_raw_timestamp
  ON stats_raw (timestamp DESC);

CREATE INDEX idx_stats_raw_source_entity_time
  ON stats_raw (source_id, entity, timestamp DESC);

CREATE INDEX idx_stats_raw_source_type_entity_time
  ON stats_raw (source_id, type_id, entity, timestamp DESC);

-- Aggregate table indexes
CREATE UNIQUE INDEX idx_stats_agg_unique
  ON stats_agg (granularity, period_start, source_id, type_id, entity);

CREATE INDEX idx_stats_agg_granularity_time
  ON stats_agg (granularity, period_start DESC);

CREATE INDEX idx_stats_agg_source_entity_granularity_time
  ON stats_agg (source_id, entity, granularity, period_start DESC);

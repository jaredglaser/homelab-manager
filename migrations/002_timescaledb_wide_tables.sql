-- Enable TimescaleDB
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Docker stats (wide table)
CREATE TABLE IF NOT EXISTS docker_stats (
  time TIMESTAMPTZ NOT NULL,
  host TEXT NOT NULL,
  container_id TEXT NOT NULL,
  container_name TEXT,
  image TEXT,
  cpu_percent DOUBLE PRECISION,
  memory_usage BIGINT,
  memory_limit BIGINT,
  memory_percent DOUBLE PRECISION,
  network_rx_bytes_per_sec DOUBLE PRECISION,
  network_tx_bytes_per_sec DOUBLE PRECISION,
  block_io_read_bytes_per_sec DOUBLE PRECISION,
  block_io_write_bytes_per_sec DOUBLE PRECISION
);

SELECT create_hypertable('docker_stats', 'time', if_not_exists => TRUE);

-- ZFS stats (wide table)
CREATE TABLE IF NOT EXISTS zfs_stats (
  time TIMESTAMPTZ NOT NULL,
  pool TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_type TEXT NOT NULL,  -- 'pool', 'vdev', 'disk'
  indent INT NOT NULL DEFAULT 0,
  capacity_alloc BIGINT,
  capacity_free BIGINT,
  read_ops_per_sec DOUBLE PRECISION,
  write_ops_per_sec DOUBLE PRECISION,
  read_bytes_per_sec DOUBLE PRECISION,
  write_bytes_per_sec DOUBLE PRECISION,
  utilization_percent DOUBLE PRECISION
);

SELECT create_hypertable('zfs_stats', 'time', if_not_exists => TRUE);

-- Compression policies
ALTER TABLE docker_stats SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'host, container_id',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('docker_stats', INTERVAL '1 hour', if_not_exists => TRUE);

ALTER TABLE zfs_stats SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'pool, entity',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('zfs_stats', INTERVAL '1 hour', if_not_exists => TRUE);

-- Retention policies (7 days raw data)
SELECT add_retention_policy('docker_stats', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('zfs_stats', INTERVAL '7 days', if_not_exists => TRUE);

-- Entity metadata (simplified - TEXT source instead of FK)
CREATE TABLE IF NOT EXISTS entity_metadata (
  source TEXT NOT NULL,
  entity TEXT NOT NULL,
  key VARCHAR(128) NOT NULL,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (source, entity, key)
);

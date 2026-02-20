-- Add host column to zfs_stats for multi-host support.
-- Mirrors the Docker multi-host pattern where each row is tagged with its source host.
-- Existing rows get a default empty string; the collector now sets host on every insert.

ALTER TABLE zfs_stats ADD COLUMN IF NOT EXISTS host TEXT NOT NULL DEFAULT '';

-- Update compression policy to segment by host for efficient multi-host storage.
-- Must remove old policy, alter settings, then re-add.
SELECT remove_compression_policy('zfs_stats', if_exists => TRUE);

-- Decompress any existing chunks so we can alter compression settings
DO $$
DECLARE
  chunk REGCLASS;
BEGIN
  FOR chunk IN
    SELECT format('%I.%I', chunk_schema, chunk_name)::regclass
    FROM timescaledb_information.chunks
    WHERE hypertable_name = 'zfs_stats' AND is_compressed
  LOOP
    EXECUTE format('SELECT decompress_chunk(%L)', chunk);
  END LOOP;
END
$$;

ALTER TABLE zfs_stats SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'host, pool, entity',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('zfs_stats', INTERVAL '1 hour', if_not_exists => TRUE);

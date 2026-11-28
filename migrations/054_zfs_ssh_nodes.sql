-- migrations/054_zfs_ssh_nodes.sql
-- ZFS is read from each node over SSH. Rows the Docker agent wrote keep their host name, with the agent
-- address dropped from the entity, so a node added under that name continues their history.
-- The aggregates are rebuilt empty: runStatsRollupBackfill fills them from raw on the next start,
-- so history older than raw retention is lost.

CREATE TABLE zfs_nodes (
  id                        SERIAL PRIMARY KEY,
  name                      TEXT NOT NULL UNIQUE CHECK (name ~ '^[A-Za-z0-9_-]{1,100}$'),
  address                   TEXT NOT NULL CHECK (address <> ''),
  port                      INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  username                  TEXT NOT NULL DEFAULT 'hlm',
  allowed_from              TEXT,
  private_key_jwe           TEXT NOT NULL,
  public_key                TEXT NOT NULL,
  host_key_fingerprint      TEXT,
  seen_host_key_fingerprint TEXT,
  state                     TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'ok', 'unreachable', 'host_key_changed', 'key_refused', 'influxdb_missing', 'timeout', 'error', 'key_unreadable'
  )),
  state_changed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at           TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A refresh locks an aggregate's materialization before its source. Taking these locks in another
-- order deadlocks with a running refresh policy.
DO $$
DECLARE
  cagg text;
  materialization regclass;
BEGIN
  IF to_regclass('zfs_stats_1h_avg') IS NOT NULL THEN
    LOCK TABLE zfs_stats_1h_avg IN ACCESS EXCLUSIVE MODE;
  END IF;
  FOREACH cagg IN ARRAY ARRAY['zfs_stats_1h', 'zfs_stats_1m'] LOOP
    CONTINUE WHEN to_regclass(cagg) IS NULL;
    EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', cagg);
    SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)::regclass
      INTO materialization
      FROM timescaledb_information.continuous_aggregates
      WHERE view_schema = current_schema() AND view_name = cagg;
    IF materialization IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', materialization);
    END IF;
  END LOOP;
  LOCK TABLE zfs_stats IN ACCESS EXCLUSIVE MODE;
END $$;

DROP VIEW IF EXISTS zfs_stats_1h_avg;
DROP MATERIALIZED VIEW IF EXISTS zfs_stats_1h;
DROP MATERIALIZED VIEW IF EXISTS zfs_stats_1m;

-- entity is a segmentby column: rewrite the rows uncompressed and let the policy compress them again.
SELECT decompress_chunk(chunk, if_compressed => TRUE) FROM show_chunks('zfs_stats') AS chunk;

-- A group header printed only dashes, so its pool row has no capacity. A real pool always has some.
DELETE FROM zfs_stats z
WHERE z.pool IN ('special', 'dedup', 'logs', 'cache')
  AND NOT EXISTS (
    SELECT 1 FROM zfs_stats p
    WHERE p.host = z.host
      AND p.pool = z.pool
      AND p.entity_type = 'pool'
      AND COALESCE(p.capacity_alloc, 0) + COALESCE(p.capacity_free, 0) > 0
  );

UPDATE zfs_stats
SET entity = substr(entity, strpos(entity, '/') + 1)
WHERE strpos(entity, '/') > 0
  AND split_part(entity, '/', 1) <> pool
  AND (
    substr(entity, strpos(entity, '/') + 1) = pool
    OR left(substr(entity, strpos(entity, '/') + 1), length(pool) + 1) = pool || '/'
  );

ALTER TABLE zfs_stats
  ADD COLUMN state TEXT,
  ADD COLUMN read_errors BIGINT,
  ADD COLUMN write_errors BIGINT,
  ADD COLUMN checksum_errors BIGINT;

CREATE MATERIALIZED VIEW zfs_stats_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 minute', time)  AS time,
  host,
  pool,
  entity,
  last(entity_type, time)                 AS entity_type,
  last(indent, time)                      AS indent,
  AVG(capacity_alloc)                     AS capacity_alloc,
  AVG(capacity_free)                      AS capacity_free,
  AVG(read_ops_per_sec)                   AS read_ops_per_sec,
  AVG(write_ops_per_sec)                  AS write_ops_per_sec,
  AVG(read_bytes_per_sec)                 AS read_bytes_per_sec,
  AVG(write_bytes_per_sec)                AS write_bytes_per_sec,
  AVG(utilization_percent)                AS utilization_percent,
  count(*)                                AS sample_count
FROM zfs_stats
GROUP BY time_bucket(INTERVAL '1 minute', time), host, pool, entity
WITH NO DATA;

CREATE MATERIALIZED VIEW zfs_stats_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', time)          AS time,
  host,
  pool,
  entity,
  last(entity_type, time)                       AS entity_type,
  last(indent, time)                            AS indent,
  SUM(capacity_alloc * sample_count)            AS capacity_alloc_sum,
  SUM(capacity_free * sample_count)             AS capacity_free_sum,
  SUM(read_ops_per_sec * sample_count)          AS read_ops_per_sec_sum,
  SUM(write_ops_per_sec * sample_count)         AS write_ops_per_sec_sum,
  SUM(read_bytes_per_sec * sample_count)        AS read_bytes_per_sec_sum,
  SUM(write_bytes_per_sec * sample_count)       AS write_bytes_per_sec_sum,
  SUM(utilization_percent * sample_count)       AS utilization_percent_sum,
  SUM(sample_count)                             AS sample_count
FROM zfs_stats_1m
GROUP BY time_bucket(INTERVAL '1 hour', time), host, pool, entity
WITH NO DATA;

CREATE VIEW zfs_stats_1h_avg AS
SELECT
  time,
  host,
  pool,
  entity,
  entity_type,
  indent,
  (capacity_alloc_sum / NULLIF(sample_count, 0))::double precision      AS capacity_alloc,
  (capacity_free_sum / NULLIF(sample_count, 0))::double precision       AS capacity_free,
  (read_ops_per_sec_sum / NULLIF(sample_count, 0))::double precision    AS read_ops_per_sec,
  (write_ops_per_sec_sum / NULLIF(sample_count, 0))::double precision   AS write_ops_per_sec,
  (read_bytes_per_sec_sum / NULLIF(sample_count, 0))::double precision  AS read_bytes_per_sec,
  (write_bytes_per_sec_sum / NULLIF(sample_count, 0))::double precision AS write_bytes_per_sec,
  (utilization_percent_sum / NULLIF(sample_count, 0))::double precision AS utilization_percent,
  sample_count
FROM zfs_stats_1h;

DO $$
DECLARE
  mat REGCLASS;
BEGIN
  SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)::regclass
    INTO mat
  FROM timescaledb_information.continuous_aggregates
  WHERE view_name = 'zfs_stats_1m';
  PERFORM set_chunk_time_interval(mat, INTERVAL '1 day');

  SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)::regclass
    INTO mat
  FROM timescaledb_information.continuous_aggregates
  WHERE view_name = 'zfs_stats_1h';
  PERFORM set_chunk_time_interval(mat, INTERVAL '7 days');
END
$$;

SELECT add_continuous_aggregate_policy('zfs_stats_1m',
  start_offset      => INTERVAL '6 hours',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '5 minutes');

SELECT add_continuous_aggregate_policy('zfs_stats_1h',
  start_offset      => INTERVAL '3 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');

ALTER MATERIALIZED VIEW zfs_stats_1m SET (
  timescaledb.compress = true,
  timescaledb.compress_segmentby = 'host, pool, entity'
);

ALTER MATERIALIZED VIEW zfs_stats_1h SET (
  timescaledb.compress = true,
  timescaledb.compress_segmentby = 'host, pool, entity'
);

SELECT add_compression_policy('zfs_stats_1m', INTERVAL '7 days');
SELECT add_compression_policy('zfs_stats_1h', INTERVAL '30 days');

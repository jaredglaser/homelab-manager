-- Multi-tier retention cascade for zfs_stats: raw (24h) -> _1m (30d) -> _1h (forever).
-- Same invariants as 030_docker_stats_retention_cascade.sql, including where the backfill
-- and the retention policies live.

-- 1-hour raw chunks: retention drops whole chunks only, so a 24-hour policy against
-- 1-day chunks would hold nearly 48 hours of raw data before reclaiming anything.
SELECT set_chunk_time_interval('zfs_stats', INTERVAL '1 hour');

CREATE MATERIALIZED VIEW IF NOT EXISTS zfs_stats_1m
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

-- Weighted sums, not AVG of AVG: a minute where a vdev appeared mid-way carries fewer
-- samples than a full 60-sample minute and must not get equal weight. See 030 for the
-- NULL-dilution limitation this shape carries.
CREATE MATERIALIZED VIEW IF NOT EXISTS zfs_stats_1h
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

-- A continuous aggregate cannot divide two aggregates, so the division lives in a plain
-- view. The double precision cast keeps AVG(bigint)'s numeric off the wire, where
-- node-postgres would hand it back as a string.
CREATE OR REPLACE VIEW zfs_stats_1h_avg AS
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
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists     => TRUE);

SELECT add_continuous_aggregate_policy('zfs_stats_1h',
  start_offset      => INTERVAL '3 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE);

ALTER MATERIALIZED VIEW zfs_stats_1m SET (
  timescaledb.compress = true,
  timescaledb.compress_segmentby = 'host, pool, entity'
);

ALTER MATERIALIZED VIEW zfs_stats_1h SET (
  timescaledb.compress = true,
  timescaledb.compress_segmentby = 'host, pool, entity'
);

SELECT add_compression_policy('zfs_stats_1m', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_compression_policy('zfs_stats_1h', INTERVAL '30 days', if_not_exists => TRUE);

SELECT remove_compression_policy('zfs_stats', if_exists => TRUE);
SELECT add_compression_policy('zfs_stats', INTERVAL '6 hours', if_not_exists => TRUE);

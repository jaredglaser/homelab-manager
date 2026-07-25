-- Multi-tier retention cascade for docker_stats: raw (24h) -> _1m (30d) -> _1h (forever).
--
-- Two invariants this file depends on:
--   1. docker_stats_1h reads docker_stats_1m, not raw. A refresh that recomputes a
--      region whose source rows are gone DELETES the aggregate for that region, so the
--      source's retention is the aggregate's recovery window. Sourcing the hourly tier
--      from the minute tier buys 30 days of slack instead of raw's 24 hours.
--   2. Every refresh window sits strictly inside its source's retention: _1m's
--      start_offset (6h) < raw retention (24h), _1h's start_offset (3d) < _1m retention (30d).
--
-- The initial backfill and the retention policies are NOT here: they run as a startup task
-- (src/lib/database/stats-rollup-backfill.ts), which can issue each
-- refresh_continuous_aggregate on its own connection outside a transaction block and only
-- adds retention once the backfill for that source has actually succeeded.

-- 1-hour raw chunks: retention drops whole chunks only, so a 24-hour policy against
-- 1-day chunks would hold nearly 48 hours of raw data before reclaiming anything.
SELECT set_chunk_time_interval('docker_stats', INTERVAL '1 hour');

CREATE MATERIALIZED VIEW IF NOT EXISTS docker_stats_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 minute', time)  AS time,
  host,
  container_id,
  last(container_name, time)              AS container_name,
  last(image, time)                       AS image,
  AVG(cpu_percent)                        AS cpu_percent,
  AVG(memory_usage)                       AS memory_usage,
  AVG(memory_limit)                       AS memory_limit,
  AVG(memory_percent)                     AS memory_percent,
  AVG(network_rx_bytes_per_sec)           AS network_rx_bytes_per_sec,
  AVG(network_tx_bytes_per_sec)           AS network_tx_bytes_per_sec,
  AVG(block_io_read_bytes_per_sec)        AS block_io_read_bytes_per_sec,
  AVG(block_io_write_bytes_per_sec)       AS block_io_write_bytes_per_sec,
  count(*)                                AS sample_count
FROM docker_stats
GROUP BY time_bucket(INTERVAL '1 minute', time), host, container_id
WITH NO DATA;

-- Weighted sums, not AVG of AVG: a minute where a container appeared mid-way carries
-- fewer samples than a full 60-sample minute and must not get equal weight.
--
-- Known limitation: SUM(metric * sample_count) skips minutes where the metric is NULL,
-- but SUM(sample_count) still counts them, so a metric that is NULL for only some minutes
-- of an hour comes out diluted. Correcting it needs a per-metric count column. The
-- collector writes every metric on every row, so in practice a column is NULL for all of
-- an entity's minutes or none of them, and both of those cases divide correctly.
CREATE MATERIALIZED VIEW IF NOT EXISTS docker_stats_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', time)                  AS time,
  host,
  container_id,
  last(container_name, time)                            AS container_name,
  last(image, time)                                     AS image,
  SUM(cpu_percent * sample_count)                       AS cpu_percent_sum,
  SUM(memory_usage * sample_count)                      AS memory_usage_sum,
  SUM(memory_limit * sample_count)                      AS memory_limit_sum,
  SUM(memory_percent * sample_count)                    AS memory_percent_sum,
  SUM(network_rx_bytes_per_sec * sample_count)          AS network_rx_bytes_per_sec_sum,
  SUM(network_tx_bytes_per_sec * sample_count)          AS network_tx_bytes_per_sec_sum,
  SUM(block_io_read_bytes_per_sec * sample_count)       AS block_io_read_bytes_per_sec_sum,
  SUM(block_io_write_bytes_per_sec * sample_count)      AS block_io_write_bytes_per_sec_sum,
  SUM(sample_count)                                     AS sample_count
FROM docker_stats_1m
GROUP BY time_bucket(INTERVAL '1 hour', time), host, container_id
WITH NO DATA;

-- A continuous aggregate cannot divide two aggregates, so the division lives in a plain
-- view. The double precision cast keeps AVG(bigint)'s numeric off the wire, where
-- node-postgres would hand it back as a string.
CREATE OR REPLACE VIEW docker_stats_1h_avg AS
SELECT
  time,
  host,
  container_id,
  container_name,
  image,
  (cpu_percent_sum / NULLIF(sample_count, 0))::double precision                  AS cpu_percent,
  (memory_usage_sum / NULLIF(sample_count, 0))::double precision                 AS memory_usage,
  (memory_limit_sum / NULLIF(sample_count, 0))::double precision                 AS memory_limit,
  (memory_percent_sum / NULLIF(sample_count, 0))::double precision               AS memory_percent,
  (network_rx_bytes_per_sec_sum / NULLIF(sample_count, 0))::double precision     AS network_rx_bytes_per_sec,
  (network_tx_bytes_per_sec_sum / NULLIF(sample_count, 0))::double precision     AS network_tx_bytes_per_sec,
  (block_io_read_bytes_per_sec_sum / NULLIF(sample_count, 0))::double precision  AS block_io_read_bytes_per_sec,
  (block_io_write_bytes_per_sec_sum / NULLIF(sample_count, 0))::double precision AS block_io_write_bytes_per_sec,
  sample_count
FROM docker_stats_1h;

DO $$
DECLARE
  mat REGCLASS;
BEGIN
  SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)::regclass
    INTO mat
  FROM timescaledb_information.continuous_aggregates
  WHERE view_name = 'docker_stats_1m';
  PERFORM set_chunk_time_interval(mat, INTERVAL '1 day');

  SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)::regclass
    INTO mat
  FROM timescaledb_information.continuous_aggregates
  WHERE view_name = 'docker_stats_1h';
  PERFORM set_chunk_time_interval(mat, INTERVAL '7 days');
END
$$;

SELECT add_continuous_aggregate_policy('docker_stats_1m',
  start_offset      => INTERVAL '6 hours',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists     => TRUE);

SELECT add_continuous_aggregate_policy('docker_stats_1h',
  start_offset      => INTERVAL '3 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE);

ALTER MATERIALIZED VIEW docker_stats_1m SET (
  timescaledb.compress = true,
  timescaledb.compress_segmentby = 'host, container_id'
);

ALTER MATERIALIZED VIEW docker_stats_1h SET (
  timescaledb.compress = true,
  timescaledb.compress_segmentby = 'host, container_id'
);

SELECT add_compression_policy('docker_stats_1m', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_compression_policy('docker_stats_1h', INTERVAL '30 days', if_not_exists => TRUE);

SELECT remove_compression_policy('docker_stats', if_exists => TRUE);
SELECT add_compression_policy('docker_stats', INTERVAL '6 hours', if_not_exists => TRUE);

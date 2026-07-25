-- Multi-tier retention cascade for proxmox_stats: raw (24h) -> _1m (30d) -> _1h (forever).
-- Same invariants as 030_docker_stats_retention_cascade.sql, including where the backfill
-- and the retention policies live.
--
-- Only cpu, mem, disk and storage_avail are true gauges and get averaged. netin/netout
-- are cumulative byte counters straight from the Proxmox API and uptime is monotonic;
-- averaging any of them yields the bucket midpoint, which reads as a plausible number
-- and is meaningless. Those carry last() instead, as do the capacity constants.

-- 1-hour raw chunks: retention drops whole chunks only, so a 24-hour policy against
-- 1-day chunks would hold nearly 48 hours of raw data before reclaiming anything.
SELECT set_chunk_time_interval('proxmox_stats', INTERVAL '1 hour');

CREATE MATERIALIZED VIEW IF NOT EXISTS proxmox_stats_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 minute', time)  AS time,
  host,
  entity_type,
  entity_id,
  last(node, time)                        AS node,
  last(entity_name, time)                 AS entity_name,
  last(status, time)                      AS status,
  AVG(cpu)                                AS cpu,
  last(max_cpu, time)                     AS max_cpu,
  AVG(mem)                                AS mem,
  last(max_mem, time)                     AS max_mem,
  AVG(disk)                               AS disk,
  last(max_disk, time)                    AS max_disk,
  last(uptime, time)                      AS uptime,
  last(vmid, time)                        AS vmid,
  last(netin, time)                       AS netin,
  last(netout, time)                      AS netout,
  last(storage_type, time)                AS storage_type,
  last(storage_content, time)             AS storage_content,
  AVG(storage_avail)                      AS storage_avail,
  last(storage_shared, time)              AS storage_shared,
  last(cluster_version, time)             AS cluster_version,
  count(*)                                AS sample_count
FROM proxmox_stats
GROUP BY time_bucket(INTERVAL '1 minute', time), host, entity_type, entity_id
WITH NO DATA;

-- Weighted sums, not AVG of AVG: a minute where a guest appeared mid-way carries fewer
-- samples than a full minute and must not get equal weight. 030 describes the
-- NULL-dilution limitation; here which of the four gauges are NULL is fixed by
-- entity_type, a group key, so within a group a column is NULL for every minute or none.
CREATE MATERIALIZED VIEW IF NOT EXISTS proxmox_stats_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', time)  AS time,
  host,
  entity_type,
  entity_id,
  last(node, time)                      AS node,
  last(entity_name, time)               AS entity_name,
  last(status, time)                    AS status,
  SUM(cpu * sample_count)               AS cpu_sum,
  last(max_cpu, time)                   AS max_cpu,
  SUM(mem * sample_count)               AS mem_sum,
  last(max_mem, time)                   AS max_mem,
  SUM(disk * sample_count)              AS disk_sum,
  last(max_disk, time)                  AS max_disk,
  last(uptime, time)                    AS uptime,
  last(vmid, time)                      AS vmid,
  last(netin, time)                     AS netin,
  last(netout, time)                    AS netout,
  last(storage_type, time)              AS storage_type,
  last(storage_content, time)           AS storage_content,
  SUM(storage_avail * sample_count)     AS storage_avail_sum,
  last(storage_shared, time)            AS storage_shared,
  last(cluster_version, time)           AS cluster_version,
  SUM(sample_count)                     AS sample_count
FROM proxmox_stats_1m
GROUP BY time_bucket(INTERVAL '1 hour', time), host, entity_type, entity_id
WITH NO DATA;

-- A continuous aggregate cannot divide two aggregates, so the division lives in a plain
-- view. The double precision cast keeps AVG(bigint)'s numeric off the wire, where
-- node-postgres would hand it back as a string.
CREATE OR REPLACE VIEW proxmox_stats_1h_avg AS
SELECT
  time,
  host,
  entity_type,
  entity_id,
  node,
  entity_name,
  status,
  (cpu_sum / NULLIF(sample_count, 0))::double precision            AS cpu,
  max_cpu,
  (mem_sum / NULLIF(sample_count, 0))::double precision            AS mem,
  max_mem,
  (disk_sum / NULLIF(sample_count, 0))::double precision           AS disk,
  max_disk,
  uptime,
  vmid,
  netin,
  netout,
  storage_type,
  storage_content,
  (storage_avail_sum / NULLIF(sample_count, 0))::double precision  AS storage_avail,
  storage_shared,
  cluster_version,
  sample_count
FROM proxmox_stats_1h;

DO $$
DECLARE
  mat REGCLASS;
BEGIN
  SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)::regclass
    INTO mat
  FROM timescaledb_information.continuous_aggregates
  WHERE view_name = 'proxmox_stats_1m';
  PERFORM set_chunk_time_interval(mat, INTERVAL '1 day');

  SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name)::regclass
    INTO mat
  FROM timescaledb_information.continuous_aggregates
  WHERE view_name = 'proxmox_stats_1h';
  PERFORM set_chunk_time_interval(mat, INTERVAL '7 days');
END
$$;

SELECT add_continuous_aggregate_policy('proxmox_stats_1m',
  start_offset      => INTERVAL '6 hours',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists     => TRUE);

SELECT add_continuous_aggregate_policy('proxmox_stats_1h',
  start_offset      => INTERVAL '3 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE);

ALTER MATERIALIZED VIEW proxmox_stats_1m SET (
  timescaledb.compress = true,
  timescaledb.compress_segmentby = 'host, entity_type, entity_id'
);

ALTER MATERIALIZED VIEW proxmox_stats_1h SET (
  timescaledb.compress = true,
  timescaledb.compress_segmentby = 'host, entity_type, entity_id'
);

SELECT add_compression_policy('proxmox_stats_1m', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_compression_policy('proxmox_stats_1h', INTERVAL '30 days', if_not_exists => TRUE);

SELECT remove_compression_policy('proxmox_stats', if_exists => TRUE);
SELECT add_compression_policy('proxmox_stats', INTERVAL '6 hours', if_not_exists => TRUE);

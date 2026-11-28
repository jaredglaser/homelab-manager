-- Per-second guest rates computed by the worker, the Proxmox rollups rebuilt to carry them, and the
-- worker's per-connection collector state.
--
-- netin/netout stay as raw counters on proxmox_stats. The rates are what the page reads.
-- A rate is NULL where none exists (first poll, restart, stopped guest, a counter that went down),
-- and each rate can be NULL on its own, so each carries its own <rate>_rate_count. The hourly tier
-- weights by that count rather than by sample_count: weighting by every row would pull an hour that
-- held a restart or a stopped stretch toward 0.
--
-- Dropping the rollups discards Proxmox history older than raw retention (24 hours). Both tiers are
-- refilled from raw, and their retention re-added, only when runStatsRollupBackfill runs after this
-- migration, which the worker does once it has migrated.

-- A refresh locks an aggregate's materialization before its source. Taking the locks in any other
-- order, as ALTER TABLE proxmox_stats before the drops did, deadlocks with a running refresh policy.
DO $$
DECLARE
  cagg text;
  materialization regclass;
BEGIN
  IF to_regclass('proxmox_stats_1h_avg') IS NOT NULL THEN
    LOCK TABLE proxmox_stats_1h_avg IN ACCESS EXCLUSIVE MODE;
  END IF;
  FOREACH cagg IN ARRAY ARRAY['proxmox_stats_1h', 'proxmox_stats_1m'] LOOP
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
  LOCK TABLE proxmox_stats IN ACCESS EXCLUSIVE MODE;
END $$;

ALTER TABLE proxmox_stats
  ADD COLUMN IF NOT EXISTS net_in_bytes_per_sec DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS net_out_bytes_per_sec DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS disk_read_bytes_per_sec DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS disk_write_bytes_per_sec DOUBLE PRECISION;

DROP VIEW IF EXISTS proxmox_stats_1h_avg;
DROP MATERIALIZED VIEW IF EXISTS proxmox_stats_1h;
DROP MATERIALIZED VIEW IF EXISTS proxmox_stats_1m;

CREATE MATERIALIZED VIEW proxmox_stats_1m
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
  AVG(net_in_bytes_per_sec)               AS net_in_bytes_per_sec,
  AVG(net_out_bytes_per_sec)              AS net_out_bytes_per_sec,
  AVG(disk_read_bytes_per_sec)            AS disk_read_bytes_per_sec,
  AVG(disk_write_bytes_per_sec)           AS disk_write_bytes_per_sec,
  count(net_in_bytes_per_sec)        AS net_in_rate_count,
  count(net_out_bytes_per_sec)       AS net_out_rate_count,
  count(disk_read_bytes_per_sec)     AS disk_read_rate_count,
  count(disk_write_bytes_per_sec)    AS disk_write_rate_count,
  last(storage_type, time)                AS storage_type,
  last(storage_content, time)             AS storage_content,
  AVG(storage_avail)                      AS storage_avail,
  last(storage_shared, time)              AS storage_shared,
  last(cluster_version, time)             AS cluster_version,
  count(*)                                AS sample_count
FROM proxmox_stats
GROUP BY time_bucket(INTERVAL '1 minute', time), host, entity_type, entity_id
WITH NO DATA;

CREATE MATERIALIZED VIEW proxmox_stats_1h
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
  SUM(net_in_bytes_per_sec * net_in_rate_count) AS net_in_bytes_per_sec_sum,
  SUM(net_out_bytes_per_sec * net_out_rate_count) AS net_out_bytes_per_sec_sum,
  SUM(disk_read_bytes_per_sec * disk_read_rate_count) AS disk_read_bytes_per_sec_sum,
  SUM(disk_write_bytes_per_sec * disk_write_rate_count) AS disk_write_bytes_per_sec_sum,
  SUM(net_in_rate_count) AS net_in_rate_count,
  SUM(net_out_rate_count) AS net_out_rate_count,
  SUM(disk_read_rate_count) AS disk_read_rate_count,
  SUM(disk_write_rate_count) AS disk_write_rate_count,
  last(storage_type, time)              AS storage_type,
  last(storage_content, time)           AS storage_content,
  SUM(storage_avail * sample_count)     AS storage_avail_sum,
  last(storage_shared, time)            AS storage_shared,
  last(cluster_version, time)           AS cluster_version,
  SUM(sample_count)                     AS sample_count
FROM proxmox_stats_1m
GROUP BY time_bucket(INTERVAL '1 hour', time), host, entity_type, entity_id
WITH NO DATA;

CREATE VIEW proxmox_stats_1h_avg AS
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
  (net_in_bytes_per_sec_sum / NULLIF(net_in_rate_count, 0))::double precision AS net_in_bytes_per_sec,
  (net_out_bytes_per_sec_sum / NULLIF(net_out_rate_count, 0))::double precision AS net_out_bytes_per_sec,
  (disk_read_bytes_per_sec_sum / NULLIF(disk_read_rate_count, 0))::double precision AS disk_read_bytes_per_sec,
  (disk_write_bytes_per_sec_sum / NULLIF(disk_write_rate_count, 0))::double precision AS disk_write_bytes_per_sec,
  net_in_rate_count,
  net_out_rate_count,
  disk_read_rate_count,
  disk_write_rate_count,
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

-- One row per Proxmox connection the worker knows. No row at all means no connection is set up.
CREATE TABLE IF NOT EXISTS proxmox_collector_state (
  connection_id   TEXT PRIMARY KEY,
  host            TEXT NOT NULL,
  port            INTEGER NOT NULL,
  state           TEXT NOT NULL,
  reason          TEXT,
  last_success_at TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT proxmox_collector_state_valid_state CHECK (
    state IN ('collecting', 'unreachable', 'token_rejected', 'certificate_refused', 'collector_off')
  )
);

CREATE OR REPLACE FUNCTION notify_proxmox_collector_state_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('proxmox_state_change', OLD.connection_id);
  ELSE
    PERFORM pg_notify('proxmox_state_change', NEW.connection_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS proxmox_collector_state_notify ON proxmox_collector_state;
CREATE TRIGGER proxmox_collector_state_notify
  AFTER INSERT OR UPDATE OR DELETE ON proxmox_collector_state
  FOR EACH ROW EXECUTE FUNCTION notify_proxmox_collector_state_change();

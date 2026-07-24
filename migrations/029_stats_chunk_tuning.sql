-- TimescaleDB tuning: 1-day chunks for the stats hypertables.
--
-- Stats hypertables collect at 1 Hz, so the default 7-day chunk interval
-- produces very large chunks that defeat chunk exclusion for the short
-- windows the UI queries (seconds to hours). 1-day chunks keep recent-data
-- queries on a single small chunk. Only affects chunks created after this
-- migration; existing chunks keep their original interval.
SELECT set_chunk_time_interval('docker_stats', INTERVAL '1 day');
SELECT set_chunk_time_interval('zfs_stats', INTERVAL '1 day');
SELECT set_chunk_time_interval('proxmox_stats', INTERVAL '1 day');

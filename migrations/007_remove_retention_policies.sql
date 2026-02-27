-- Remove 7-day retention policies from hypertables.
-- Compression keeps storage manageable, so infinite retention is viable
-- for homelab-scale data.
SELECT remove_retention_policy('docker_stats', if_exists => TRUE);
SELECT remove_retention_policy('zfs_stats', if_exists => TRUE);

-- Change compression interval from 1 hour to 7 days.
-- This matches the TimescaleDB recommended default:
--   - Recent data (< 7 days) stays uncompressed for fast queries
--   - Older data compresses automatically for storage efficiency
--   - Wider buffer for late-arriving writes after worker restarts
SELECT remove_compression_policy('docker_stats', if_exists => TRUE);
SELECT remove_compression_policy('zfs_stats', if_exists => TRUE);
SELECT add_compression_policy('docker_stats', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_compression_policy('zfs_stats', INTERVAL '7 days', if_not_exists => TRUE);

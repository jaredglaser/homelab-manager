-- Replace seq-based poll cursor with time-based polling (WHERE time > $1).
-- PostgreSQL automatically drops associated indexes when columns are dropped,
-- so the seq indexes from migration 006 are cleaned up automatically.

ALTER TABLE docker_stats DROP COLUMN IF EXISTS seq;
ALTER TABLE zfs_stats DROP COLUMN IF EXISTS seq;

-- Add monotonically increasing sequence columns for reliable SSE cursor tracking.
-- Independent collectors produce rows with overlapping timestamp ranges,
-- making time-based cursors unreliable. A shared BIGSERIAL guarantees
-- a total ordering across all inserts.

ALTER TABLE docker_stats ADD COLUMN seq BIGSERIAL;
ALTER TABLE zfs_stats ADD COLUMN seq BIGSERIAL;

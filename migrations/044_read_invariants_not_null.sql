-- Two columns were read into row types with no null member while the schema still
-- allowed NULL, and no writer can produce one: every managed_hosts INSERT omits
-- status and takes the DEFAULT 'pending', and every entity_metadata write passes a
-- value. Carry the invariant in the schema so the repository row type can be exactly
-- `string` instead of a union the wire cannot actually produce.
--
-- Backfill before tightening: a database written before the invariant could hold
-- NULLs, and ALTER ... SET NOT NULL fails while any remain. Both backfills keep the
-- existing rows (and their row counts) rather than deleting value-less state.
-- 'pending' is the column's own default; '' is treated as absent by readers.

UPDATE managed_hosts SET status = 'pending' WHERE status IS NULL;

ALTER TABLE managed_hosts ALTER COLUMN status SET NOT NULL;

UPDATE entity_metadata SET value = '' WHERE value IS NULL;

ALTER TABLE entity_metadata ALTER COLUMN value SET NOT NULL;

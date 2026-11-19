-- Two columns were read into row types with no null member while the schema still
-- allowed NULL, and no writer can produce one: every managed_hosts INSERT omits
-- status and takes the DEFAULT 'pending', and every entity_metadata write passes a
-- value. Carry the invariant in the schema so the repository row type can be exactly
-- `string` instead of a union the wire cannot actually produce.
--
-- Deliberately no backfill, matching 010_deploy_constraints.sql. Both are pure
-- tightenings: for every row a running system can have written, the invariant already
-- holds. A NULL could only come from a hand-edited row, and guessing a value for one
-- is worse than refusing to: '' is NOT absent to these readers (getEntityIcon and
-- getServiceKeyForEntity return it verbatim through `?? null`, and
-- getLinkedContainerIds joins on `sibling.value = me.value`, so two empty values would
-- link to each other in a way a NULL never did). If a NULL does exist, the ALTER stops
-- and names the column, and the row gets looked at instead of being invented into.

ALTER TABLE managed_hosts ALTER COLUMN status SET NOT NULL;

ALTER TABLE entity_metadata ALTER COLUMN value SET NOT NULL;

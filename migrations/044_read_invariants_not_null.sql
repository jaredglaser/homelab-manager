-- No backfill on purpose (as 010): a NULL here can only be hand-edited, so the ALTER stops
-- and names the column rather than inventing '' (getLinkedContainerIds joins on value equality).

ALTER TABLE managed_hosts ALTER COLUMN status SET NOT NULL;

ALTER TABLE entity_metadata ALTER COLUMN value SET NOT NULL;

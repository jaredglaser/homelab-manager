-- stacks/expandedStacks was written by a settings hook no UI ever called: the
-- stacks route never had expandable rows. Drop the orphaned row so the key
-- stops appearing in the settings table.

DELETE FROM settings WHERE key = 'stacks/expandedStacks';

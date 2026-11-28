-- These keys moved to per-browser storage. The server rejects writes to them, so a leftover row would only ride the settings init frame.
DELETE FROM settings WHERE key IN (
  'docker/expandedHosts',
  'docker/expandedContainers',
  'docker/containerShells',
  'stacks/expandedStacks',
  'zfs/expandedHosts',
  'zfs/expandedPools',
  'zfs/expandedVdevs',
  'proxmox/expandedHosts',
  'proxmox/expandedSections'
);

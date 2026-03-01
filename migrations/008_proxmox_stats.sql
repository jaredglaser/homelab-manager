-- Proxmox cluster stats (wide table with entity_type discriminator)
-- Stores all Proxmox entity types in a single table:
--   cluster, node, qemu, lxc, storage
CREATE TABLE IF NOT EXISTS proxmox_stats (
  time TIMESTAMPTZ NOT NULL,
  host TEXT NOT NULL,
  entity_type TEXT NOT NULL,  -- 'cluster', 'node', 'qemu', 'lxc', 'storage'
  node TEXT,                  -- NULL for cluster-level rows
  entity_id TEXT NOT NULL,    -- unique ID: cluster name, node name, vmid, node/storage
  entity_name TEXT,           -- display name
  status TEXT,

  -- Compute metrics (nodes + guests)
  cpu DOUBLE PRECISION,
  max_cpu DOUBLE PRECISION,
  mem BIGINT,
  max_mem BIGINT,
  disk BIGINT,
  max_disk BIGINT,
  uptime BIGINT,

  -- Guest-specific
  vmid INT,
  netin BIGINT,
  netout BIGINT,

  -- Storage-specific
  storage_type TEXT,
  storage_content TEXT,
  storage_avail BIGINT,
  storage_shared BOOLEAN,

  -- Cluster-level
  cluster_version INT
);

SELECT create_hypertable('proxmox_stats', 'time', if_not_exists => TRUE);

ALTER TABLE proxmox_stats SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'host, entity_type, entity_id',
  timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('proxmox_stats', INTERVAL '7 days', if_not_exists => TRUE);

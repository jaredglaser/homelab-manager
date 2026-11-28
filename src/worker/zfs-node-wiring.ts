import type { DatabaseClient, DatabaseConfig } from '@/lib/clients/database-client';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import { StatsRepository } from '@/lib/database/repositories/stats-repository';
import { ZFS_NODES_NOTIFY_CHANNEL, ZfsNodeRepository } from '@/lib/database/repositories/zfs-node-repository';
import { createSsh2Transport } from '@/lib/zfs/ssh-transport';
import { ZfsNodeCollector } from './collectors/zfs-node-collector';
import { HostsListener } from './hosts-listener';
import { ZfsNodeManager } from './zfs-node-manager';

/** Starts one collector per confirmed ZFS node and reconciles them on every `zfs_nodes_change` notify. */
export async function startZfsNodeCollection(
  db: DatabaseClient,
  dbConfig: DatabaseConfig,
  keyring: MasterKeyring,
  signal: AbortSignal,
  stack: AsyncDisposableStack,
): Promise<ZfsNodeManager> {
  const nodes = new ZfsNodeRepository(db.getPool(), keyring);
  const stats = new StatsRepository(db.getPool());
  const transport = createSsh2Transport();
  const manager = stack.use(
    new ZfsNodeManager(
      signal,
      () => nodes.listConfirmedConnections(),
      (node, controller) => new ZfsNodeCollector(node, { transport, states: nodes, insertRows: (rows) => stats.insertZFSStats(rows) }, controller),
    ),
  );
  const listener = stack.use(new HostsListener(dbConfig, () => manager.reconcile(), signal, ZFS_NODES_NOTIFY_CHANNEL));
  await listener.start();
  await manager.reconcile();
  return manager;
}

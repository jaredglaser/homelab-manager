import { createHash } from 'node:crypto';
import type { DatabaseClient, DatabaseConfig } from '@/lib/clients/database-client';
import type { ProxmoxConnection } from '@/lib/config/proxmox-config';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import {
  PROXMOX_CONNECTIONS_NOTIFY_CHANNEL,
  ProxmoxConnectionRepository,
  type ProxmoxConnectionForWorker,
} from '@/lib/database/repositories/proxmox-connection-repository';
import { ProxmoxStateRepository } from '@/lib/database/repositories/proxmox-state-repository';
import { ProxmoxCollector } from './collectors/proxmox-collector';
import { HostsListener } from './hosts-listener';

export type ProxmoxCollectorFactory = (connection: ProxmoxConnection, controller: AbortController) => ProxmoxCollector;

interface Entry {
  controller: AbortController;
  collector: ProxmoxCollector;
  runner: Promise<void>;
  identity: string;
  onGlobalAbort: () => void;
}

/** A renamed connection, or a secret re-encrypted by key rotation, keeps its running collector. */
function identityFor(connection: ProxmoxConnection): string {
  const secretHash = createHash('sha256').update(connection.tokenSecret).digest('hex');
  return JSON.stringify([connection.host, connection.port, connection.tokenId, secretHash, connection.allowSelfSignedCerts]);
}

/** One collector per saved Proxmox connection. `reconcile` serialises through a chain, so back-to-back notifies cannot race. */
export class ProxmoxConnectionManager implements AsyncDisposable {
  private readonly entries = new Map<number, Entry>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly globalSignal: AbortSignal,
    private readonly listConnections: () => Promise<ProxmoxConnectionForWorker[]>,
    private readonly createCollector: ProxmoxCollectorFactory,
    private readonly removeOrphanStates: () => Promise<void> = async () => {},
  ) {}

  collectors(): ProxmoxCollector[] {
    return [...this.entries.values()].map((entry) => entry.collector);
  }

  runners(): Promise<void>[] {
    return [...this.entries.values()].map((entry) => entry.runner);
  }

  reconcile(): Promise<void> {
    const next = this.chain.then(() => this.reconcileOnce());
    this.chain = next.catch(() => {});
    return next;
  }

  private async reconcileOnce(): Promise<void> {
    if (this.globalSignal.aborted) return;
    let saved: ProxmoxConnectionForWorker[];
    try {
      saved = await this.listConnections();
    } catch (err) {
      console.error('[ProxmoxConnectionManager] listing Proxmox connections failed:', err instanceof Error ? err.message : err);
      return;
    }
    const byId = new Map(saved.map((entry) => [entry.id, entry]));
    let removed = false;
    for (const [id, entry] of [...this.entries]) {
      const next = byId.get(id);
      // An undecryptable secret (a key missing from this worker) keeps the collector that already runs.
      if (next?.connection === null) continue;
      if (!next?.connection || identityFor(next.connection) !== entry.identity) {
        await this.remove(id);
        removed = true;
      }
    }
    for (const entry of saved) {
      if (entry.connection && !this.entries.has(entry.id)) this.add(entry.connection);
    }
    if (removed) {
      try {
        await this.removeOrphanStates();
      } catch (err) {
        console.error('[ProxmoxConnectionManager] clearing the state of removed connections failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  private add(connection: ProxmoxConnection): void {
    if (this.globalSignal.aborted) return;
    const controller = new AbortController();
    const onGlobalAbort = () => controller.abort();
    this.globalSignal.addEventListener('abort', onGlobalAbort, { once: true });
    const collector = this.createCollector(connection, controller);
    const runner = collector.run().catch((err) => {
      console.error(`[ProxmoxConnectionManager] ${collector.name} exited with error:`, err instanceof Error ? err.message : err);
    });
    console.info(`[ProxmoxConnectionManager] started collection for ${connection.name} (${connection.host}:${connection.port})`);
    this.entries.set(connection.id, { controller, collector, runner, identity: identityFor(connection), onGlobalAbort });
  }

  private async remove(id: number): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    console.info(`[ProxmoxConnectionManager] stopping ${entry.collector.name}`);
    this.globalSignal.removeEventListener('abort', entry.onGlobalAbort);
    entry.controller.abort(new DOMException('Proxmox connection removed', 'AbortError'));
    await entry.runner;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.remove(id)));
  }
}

/** Starts one collector per saved connection and reconciles them on every `proxmox_connections_change` notify. */
export async function startProxmoxCollection(
  db: DatabaseClient,
  dbConfig: DatabaseConfig,
  workerConfig: WorkerConfig,
  keyring: MasterKeyring,
  pollIntervalMs: () => number,
  signal: AbortSignal,
  stack: AsyncDisposableStack,
): Promise<ProxmoxConnectionManager> {
  const connections = new ProxmoxConnectionRepository(db.getPool(), keyring);
  const states = new ProxmoxStateRepository(db.getPool());
  const manager = stack.use(
    new ProxmoxConnectionManager(
      signal,
      () => connections.listForWorker(),
      (connection, controller) => new ProxmoxCollector(db, workerConfig, connection, pollIntervalMs(), controller),
      () => states.removeOrphans(),
    ),
  );
  const listener = stack.use(new HostsListener(dbConfig, () => manager.reconcile(), signal, PROXMOX_CONNECTIONS_NOTIFY_CHANNEL));
  await listener.start();
  await manager.reconcile();
  return manager;
}

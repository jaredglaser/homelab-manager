import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import {
  type HostCapabilities,
  type ManagedHost,
} from '@/lib/database/repositories/host-repository';
import { DockerContainerEventRepository } from '@/lib/database/repositories/docker-container-event-repository';
import { EntityMetadataRepository } from '@/lib/database/repositories/entity-metadata-repository';
import { LogShapeRepository } from '@/lib/database/repositories/log-shape-repository';
import { DetectorRuleRepository } from '@/lib/database/repositories/detector-rule-repository';
import type { BaseCollector } from './collectors/base-collector';
import { AgentStatsCollector } from './collectors/agent-stats-collector';
import { ContainerInventoryCollector } from './collectors/container-inventory-collector';
import { ZFSCollector } from './collectors/zfs-collector';
import { resolveAgentUrl } from './collector-factory';
import { LogWatcher } from './log-watcher/log-watcher';
import type { LogBaselineRepository, LogWatcherDeps } from './log-watcher/log-watcher';
import type { HermesDispatcher } from './log-watcher/hermes-dispatcher';

export interface HostCollectorBundle {
  collectors: BaseCollector[];
  runners: Promise<void>[];
}

/**
 * Builds the set of collectors for a single managed host. Injected so
 * tests can substitute fakes that don't open sockets or hit Docker.
 */
export type HostCollectorFactory = (
  host: ManagedHost,
  signer: () => Promise<string>,
  controller: AbortController,
  stack: AsyncDisposableStack,
) => HostCollectorBundle;

interface HostEntry {
  /** Per-host AbortController so a single host can be stopped without aborting peers. */
  controller: AbortController;
  /** All collectors for this host; disposing stops them all. */
  stack: AsyncDisposableStack;
  /** All run() promises for this host; awaited on full shutdown. */
  runners: Promise<void>[];
  /** Collector instances exposed for runtime setting propagation. */
  collectors: BaseCollector[];
  /** Identity hash to detect when reconciliation needs to recreate this host. */
  identity: string;
  /**
   * Reference to the listener registered on the global abort signal so
   * removeHost can detach it. Without this, every add/remove cycle leaks a
   * closure on the global signal; `{ once: true }` only fires on the
   * shutdown path, never on dynamic removes.
   */
  onGlobalAbort: () => void;
}

function identityFor(host: ManagedHost): string {
  return `${host.agentUrl}::${JSON.stringify(host.capabilities ?? {})}`;
}

function shouldStartDocker(workerConfig: WorkerConfig, caps: HostCapabilities | undefined): boolean {
  return Boolean(workerConfig.docker.enabled && caps?.docker);
}

function shouldStartZfs(workerConfig: WorkerConfig, caps: HostCapabilities | undefined): boolean {
  return Boolean(workerConfig.zfs.enabled && caps?.zfs);
}

const LOG_BASELINE_METADATA_KEY = 'logBaselineState';

/**
 * Persists LogWatcher's per-entity EWMA baseline through entity_metadata. Migration 037's
 * own rationale for storing criticality there applies identically here: a generic
 * (source, entity, key) -> value row keyed by the same host/container_id entity id, no
 * new table needed.
 */
export class EntityMetadataBaselineRepository implements LogBaselineRepository {
  constructor(private readonly metadata: EntityMetadataRepository) {}

  async loadMany(entityIds: readonly string[]): Promise<Map<string, string>> {
    const rows = await this.metadata.getEntityMetadata([...entityIds]);
    const out = new Map<string, string>();
    for (const [entity, kv] of rows) {
      const state = kv.get(LOG_BASELINE_METADATA_KEY);
      if (state !== undefined) out.set(entity, state);
    }
    return out;
  }

  async saveMany(entries: readonly { readonly entityId: string; readonly state: string }[]): Promise<void> {
    if (entries.length === 0) return;
    await this.metadata.upsertEntityMetadataBatch(
      entries.map((e) => ({ entity: e.entityId, key: LOG_BASELINE_METADATA_KEY, value: e.state })),
    );
  }
}

/**
 * Default factory that wires up the real collector classes. Extracted so
 * tests can inject a fake without monkey-patching modules.
 *
 * `hermesDispatcher` is omitted when the Hermes push path's feature flag is off
 * (see createHermesDispatcher in collector-factory.ts); no LogWatcher is built and no
 * log-watcher repository is constructed in that case.
 */
export function defaultHostCollectorFactory(
  db: DatabaseClient,
  workerConfig: WorkerConfig,
  hermesDispatcher?: HermesDispatcher,
): HostCollectorFactory {
  const inventoryRepo = new DockerContainerEventRepository(db.getPool());
  const entityMetadataRepo = hermesDispatcher ? new EntityMetadataRepository(db.getPool()) : null;
  const logWatcherDeps: Omit<LogWatcherDeps, 'onSignal'> | null =
    hermesDispatcher && entityMetadataRepo
      ? {
          logShapeRepository: new LogShapeRepository(db.getPool()),
          detectorRuleRepository: new DetectorRuleRepository(db.getPool()),
          entityMetadataRepository: entityMetadataRepo,
          containerEventRepository: inventoryRepo,
          baselineRepository: new EntityMetadataBaselineRepository(entityMetadataRepo),
        }
      : null;

  return (host, signer, controller, stack) => {
    const collectors: BaseCollector[] = [];
    const runners: Promise<void>[] = [];
    const resolved = { ...host, agentUrl: resolveAgentUrl(host.agentUrl) };
    const dockerWanted = shouldStartDocker(workerConfig, host.capabilities);
    const zfsWanted = shouldStartZfs(workerConfig, host.capabilities);

    if (dockerWanted) {
      const stats = stack.use(new AgentStatsCollector(db, workerConfig, resolved, signer, controller));
      collectors.push(stats);
      runners.push(stats.run());

      const inventory = stack.use(
        new ContainerInventoryCollector(
          { name: host.name, agentUrl: resolved.agentUrl },
          signer,
          inventoryRepo,
          controller,
        ),
      );
      collectors.push(inventory);
      runners.push(inventory.run());

      if (hermesDispatcher && logWatcherDeps) {
        const logWatcher = stack.use(
          new LogWatcher(
            { name: host.name, agentUrl: resolved.agentUrl },
            signer,
            {
              ...logWatcherDeps,
              onSignal: (signal) => hermesDispatcher.submit(signal),
              onRunningCountChange: (running) => hermesDispatcher.setRunningContainerCount(host.name, running),
            },
            controller,
          ),
        );
        collectors.push(logWatcher);
        runners.push(logWatcher.run());
      }
    }

    if (zfsWanted) {
      const zfs = stack.use(new ZFSCollector(db, workerConfig, resolved, signer, controller));
      collectors.push(zfs);
      runners.push(zfs.run());
    }

    return { collectors, runners };
  };
}

/**
 * Owns the lifecycle of per-managed-host collectors. Holds one
 * AsyncDisposableStack per host so a single host can be added or removed
 * without disturbing the others. `reconcile()` is the only mutator and is
 * safe to call concurrently with itself: it serialises through an internal
 * promise chain so two notifications arriving back-to-back don't race.
 */
export class HostCollectorManager implements AsyncDisposable {
  private readonly entries = new Map<string, HostEntry>();
  private reconcileChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly workerConfig: WorkerConfig,
    private readonly globalSignal: AbortSignal,
    private readonly findAllHosts: () => Promise<ManagedHost[]>,
    private readonly getSigner: (hostname: string) => Promise<(() => Promise<string>) | null>,
    private readonly collectorFactory: HostCollectorFactory,
  ) {}

  /** Snapshot of all running collector instances across hosts. */
  collectors(): BaseCollector[] {
    const out: BaseCollector[] = [];
    for (const entry of this.entries.values()) out.push(...entry.collectors);
    return out;
  }

  /** Snapshot of all run() promises so the worker can await them on shutdown. */
  runners(): Promise<void>[] {
    const out: Promise<void>[] = [];
    for (const entry of this.entries.values()) out.push(...entry.runners);
    return out;
  }

  hostNames(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Synchronise the active collector set with the current `managed_hosts`
   * table contents. Adds collectors for new hosts, disposes them for
   * removed hosts, and recreates them for hosts whose `agentUrl` or
   * capabilities changed. Signer-resolution failures are logged and the
   * host is skipped (matches startup behavior).
   */
  reconcile(): Promise<void> {
    const next = this.reconcileChain.then(() => this.reconcileOnce());
    this.reconcileChain = next.catch(() => {});
    return next;
  }

  private async reconcileOnce(): Promise<void> {
    if (this.globalSignal.aborted) return;

    let desired: ManagedHost[];
    try {
      desired = await this.findAllHosts();
    } catch (err) {
      console.error('[HostCollectorManager] findAllHosts failed:', err instanceof Error ? err.message : err);
      return;
    }

    const desiredByName = new Map(desired.map((h) => [h.name, h]));

    // Remove hosts no longer present
    for (const name of [...this.entries.keys()]) {
      if (!desiredByName.has(name)) {
        await this.removeHost(name);
      }
    }

    // Add new hosts and recreate changed ones
    for (const host of desired) {
      const existing = this.entries.get(host.name);
      const newIdentity = identityFor(host);
      if (!existing) {
        await this.addHost(host);
      } else if (existing.identity !== newIdentity) {
        await this.removeHost(host.name);
        await this.addHost(host);
      }
    }
  }

  private async addHost(host: ManagedHost): Promise<void> {
    if (this.globalSignal.aborted) return;

    let signer: (() => Promise<string>) | null;
    try {
      signer = await this.getSigner(host.name);
    } catch (err) {
      console.error(
        `[HostCollectorManager] Signer fetch failed for ${host.name}:`,
        err instanceof Error ? err.message : err,
      );
      return;
    }
    if (!signer) {
      console.info(`[HostCollectorManager] No agent keypair for ${host.name}, skipping`);
      return;
    }

    const dockerWanted = shouldStartDocker(this.workerConfig, host.capabilities);
    const zfsWanted = shouldStartZfs(this.workerConfig, host.capabilities);
    if (!dockerWanted && !zfsWanted) {
      console.info(`[HostCollectorManager] No applicable capabilities for ${host.name}, skipping`);
      return;
    }

    const controller = new AbortController();
    if (this.globalSignal.aborted) return;
    const onGlobalAbort = () => controller.abort();
    this.globalSignal.addEventListener('abort', onGlobalAbort, { once: true });

    const stack = new AsyncDisposableStack();
    const { collectors, runners } = this.collectorFactory(host, signer, controller, stack);

    if (collectors.length === 0) {
      console.info(`[HostCollectorManager] Factory returned no collectors for ${host.name}, skipping`);
      this.globalSignal.removeEventListener('abort', onGlobalAbort);
      await stack[Symbol.asyncDispose]();
      return;
    }

    // Wrap each runner so a thrown rejection is logged with host context
    // instead of becoming an unhandled rejection.
    const wrappedRunners = runners.map((p, i) =>
      p.catch((err) => {
        console.error(
          `[HostCollectorManager] Runner ${i} for ${host.name} exited with error:`,
          err instanceof Error ? err.message : err,
        );
      }),
    );

    console.info(`[HostCollectorManager] Started ${collectors.length} collector(s) for ${host.name}`);

    this.entries.set(host.name, {
      controller,
      stack,
      runners: wrappedRunners,
      collectors,
      identity: identityFor(host),
      onGlobalAbort,
    });
  }

  private async removeHost(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) return;
    this.entries.delete(name);
    console.info(`[HostCollectorManager] Removing collectors for ${name}`);
    // Detach the per-host abort listener before aborting so the listener
    // doesn't fire (it's already a no-op since we abort manually next, but
    // detaching is what frees the closure on the global signal).
    this.globalSignal.removeEventListener('abort', entry.onGlobalAbort);
    entry.controller.abort(new DOMException('Host removed', 'AbortError'));
    // Await all runners so the per-host stack is genuinely idle before disposal.
    await Promise.allSettled(entry.runners);
    await entry.stack[Symbol.asyncDispose]();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const names = [...this.entries.keys()];
    await Promise.all(names.map((n) => this.removeHost(n)));
  }
}

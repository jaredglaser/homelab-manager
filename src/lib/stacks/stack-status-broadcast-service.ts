import type { PoolClient } from 'pg';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';
import type { StackContainer, StackStatusEntry } from '@/types/stacks';
import type {
  DockerContainerEventRow,
  DockerContainerEventUpsertRow,
} from '@/lib/database/repositories/docker-container-event-repository';
import { notifyPayloadToInventory, rowToInventory } from '@/lib/docker/docker-inventory-broadcast-service';
import { backoffDelayMs } from '@/lib/utils/backoff';

/** Discriminated union for events sent to SSE subscribers. */
export type StackBroadcastEvent =
  | { type: 'status'; entries: StackStatusEntry[] }
  | { type: 'deploy_changed'; stack: string; host: string };

type StackBroadcastCallback = (event: StackBroadcastEvent) => void;

export interface StackStatusBroadcastServiceDeps {
  getPoolClient?: () => Promise<PoolClient>;
  loadSnapshot?: () => Promise<DockerInventorySnapshotContainer[]>;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 32_000;

function toStackContainer(inv: DockerInventorySnapshotContainer): StackContainer {
  return {
    id: inv.containerId,
    name: inv.name,
    status: inv.state,
    image: inv.image,
  };
}

function toStackEntry(host: string, stack: string, containers: DockerInventorySnapshotContainer[]): StackStatusEntry {
  return {
    host,
    stack,
    containers: containers.map(toStackContainer),
    updated_at: new Date(Math.max(...containers.map((c) => c.updatedAt.getTime()))).toISOString(),
  };
}

/**
 * Returns a stable map key for a (host, composeProject) pair.
 * Using '/' separator — same convention as entity IDs throughout the codebase.
 */
function stackKey(host: string, composeProject: string): string {
  return `${host}/${composeProject}`;
}

async function defaultGetPoolClient(): Promise<PoolClient> {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  return client.getPool().connect();
}

async function defaultLoadSnapshot(): Promise<DockerInventorySnapshotContainer[]> {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { DockerContainerEventRepository } = await import(
    '@/lib/database/repositories/docker-container-event-repository'
  );
  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  const repo = new DockerContainerEventRepository(client.getPool());
  const rows: DockerContainerEventRow[] = await repo.getCurrentSnapshot();
  return rows
    .filter((row): row is DockerContainerEventUpsertRow => row.eventType === 'upsert')
    .map(rowToInventory);
}

/**
 * Group a flat list of container inventory items into stack entries.
 * Containers with null composeProject are excluded — they belong to no stack.
 */
function inventoryToStackEntries(containers: DockerInventorySnapshotContainer[]): StackStatusEntry[] {
  const byStack = new Map<string, DockerInventorySnapshotContainer[]>();
  for (const c of containers) {
    if (c.composeProject === null) continue;
    const key = stackKey(c.host, c.composeProject);
    const existing = byStack.get(key);
    if (existing) {
      existing.push(c);
    } else {
      byStack.set(key, [c]);
    }
  }
  return Array.from(byStack.entries()).map(([, group]) =>
    toStackEntry(group[0].host, group[0].composeProject!, group),
  );
}

/**
 * Server-side broadcast service for stack status changes.
 *
 * Derives stack state from docker_container_events grouped by compose_project.
 * Listens on two PostgreSQL NOTIFY channels:
 *   - 'docker_container_change' — triggers stack snapshot re-derivation for the affected stack.
 *   - 'deploy_change' — forwards deploy lifecycle events as-is (written directly by the deploy pipeline).
 *
 * Auto-starts on first subscriber, auto-stops on last unsubscribe.
 */
export class StackStatusBroadcastService {
  private subscribers = new Set<StackBroadcastCallback>();
  private listenerClient: PoolClient | null = null;
  private stopped = true;
  private reconnecting = false;
  private reconnectFailures = 0;
  /** Instance-scoped so reconnect iterations preserve it and take the snapshot-reload branch. */
  private isFirstConnect = true;
  /** Timer reference so stop() can cancel a pending reconnect. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** In-memory map from 'host/stack' → per-container inventory for that stack. */
  private readonly stackContainers = new Map<string, Map<string, DockerInventorySnapshotContainer>>();

  private readonly getPoolClient: () => Promise<PoolClient>;
  private readonly loadSnapshot: () => Promise<DockerInventorySnapshotContainer[]>;

  constructor(deps: StackStatusBroadcastServiceDeps = {}) {
    this.getPoolClient = deps.getPoolClient ?? defaultGetPoolClient;
    this.loadSnapshot = deps.loadSnapshot ?? defaultLoadSnapshot;
  }

  subscribe(callback: StackBroadcastCallback): () => void {
    this.subscribers.add(callback);

    if (this.subscribers.size === 1) {
      // Await startListening before sendInit to ensure LISTEN is registered first.
      // This prevents an upsert arriving before the init on the client.
      void this.startListening().then(() => this.sendInit(callback));
    } else {
      void this.sendInit(callback);
    }

    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.stopListening();
      }
    };
  }

  private async sendInit(callback: StackBroadcastCallback): Promise<void> {
    try {
      let entries: StackStatusEntry[];

      if (this.stackContainers.size === 0) {
        // First subscriber: seed in-memory state from DB snapshot
        const containers = await this.loadSnapshot();
        this.rebuildFromSnapshot(containers);
        entries = inventoryToStackEntries(containers);
      } else {
        // Subsequent subscribers: serve current in-memory state without a DB round-trip
        entries = this.buildInitPayloadFromMemory();
      }

      if (this.subscribers.has(callback)) {
        callback({ type: 'status', entries });
      }
    } catch (error) {
      console.error('[StackStatusBroadcastService] Failed to send init:', error);
    }
  }

  /** Build an init payload from the current in-memory stackContainers without touching the DB. */
  private buildInitPayloadFromMemory(): StackStatusEntry[] {
    const entries: StackStatusEntry[] = [];
    for (const [sk, byContainer] of this.stackContainers) {
      const containers = Array.from(byContainer.values());
      if (containers.length === 0) continue;
      const [host, ...stackParts] = sk.split('/');
      const stack = stackParts.join('/');
      entries.push(toStackEntry(host, stack, containers));
    }
    return entries;
  }

  /** Rebuild in-memory stackContainers from a fresh snapshot. */
  private rebuildFromSnapshot(containers: DockerInventorySnapshotContainer[]): void {
    this.stackContainers.clear();
    for (const c of containers) {
      if (c.composeProject === null) continue;
      const sk = stackKey(c.host, c.composeProject);
      let byContainer = this.stackContainers.get(sk);
      if (!byContainer) {
        byContainer = new Map();
        this.stackContainers.set(sk, byContainer);
      }
      byContainer.set(`${c.host}/${c.containerId}`, c);
    }
  }

  private async startListening(): Promise<void> {
    this.stopped = false;

    while (!this.stopped) {
      try {
        const poolClient = await this.getPoolClient();

        if (this.stopped) {
          try { poolClient.release(); } catch { /* best-effort */ }
          return;
        }

        // Bind handlers to this specific client so a stale handler firing after
        // the client has been replaced cannot mutate shared state for the new one.
        const currentClient = poolClient;
        this.listenerClient = currentClient;

        currentClient.on('notification', (msg) => {
          if (this.listenerClient !== currentClient) return;
          if (msg.channel === 'docker_container_change') {
            this.handleContainerChange(msg.payload);
          } else if (msg.channel === 'deploy_change') {
            this.handleDeployChange(msg.payload);
          }
        });

        currentClient.on('error', (err) => {
          console.error('[StackStatusBroadcastService] Listener client error:', err);
          if (this.listenerClient !== currentClient) {
            // Stale handler for a replaced client — do not touch shared state.
            return;
          }
          this.cleanupListenerClient();
          if (!this.stopped && this.subscribers.size > 0 && !this.reconnecting) {
            this.reconnecting = true;
            const delay = backoffDelayMs(this.reconnectFailures, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS });
            if (this.reconnectFailures === 0) {
              console.error(`[StackStatusBroadcastService] DB connection lost, reconnecting (delay ${delay}ms)`);
            } else if (this.reconnectFailures % 10 === 0) {
              console.warn(`[StackStatusBroadcastService] Still reconnecting after ${this.reconnectFailures} attempts (delay ${delay}ms)`);
            } else {
              console.debug(`[StackStatusBroadcastService] Reconnect attempt ${this.reconnectFailures + 1} (delay ${delay}ms)`);
            }
            this.reconnectFailures++;
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              this.reconnecting = false;
              if (!this.stopped && this.subscribers.size > 0) {
                void this.startListening();
              }
            }, delay);
          }
        });

        // LISTEN registered before snapshot reload so NOTIFYs arriving during the reload are not dropped
        await currentClient.query('LISTEN docker_container_change');
        await currentClient.query('LISTEN deploy_change');

        if (!this.isFirstConnect) {
          // Reconnect path: reload snapshot to catch up on missed NOTIFYs
          try {
            const containers = await this.loadSnapshot();
            this.rebuildFromSnapshot(containers);
          } catch (err) {
            console.error('[StackStatusBroadcastService] Failed to reload snapshot on reconnect:', err);
          }
          // Reset backoff on successful reconnect
          this.reconnectFailures = 0;
        }

        this.isFirstConnect = false;
        return;
      } catch (error) {
        const delay = backoffDelayMs(this.reconnectFailures, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS });
        console.error(`[StackStatusBroadcastService] Failed to start listener, retrying in ${delay}ms:`, error);
        this.isFirstConnect = false;
        this.reconnectFailures++;
        await new Promise<void>((resolve) => {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            resolve();
          }, delay);
        });
      }
    }
  }

  private broadcastStack(host: string, composeProject: string, eventAt: string): void {
    const sk = stackKey(host, composeProject);
    const byContainer = this.stackContainers.get(sk);
    const stackGroup = byContainer ? Array.from(byContainer.values()) : [];
    const entry: StackStatusEntry = stackGroup.length > 0
      ? toStackEntry(host, composeProject, stackGroup)
      : { host, stack: composeProject, containers: [], updated_at: eventAt };

    const entries: StackStatusEntry[] = [entry];
    for (const cb of this.subscribers) {
      try {
        cb({ type: 'status', entries });
      } catch (err) {
        console.error('[StackStatusBroadcastService] Subscriber callback failed:', err);
      }
    }
  }

  private handleContainerChange(payload?: string): void {
    if (!payload) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      console.error('[StackStatusBroadcastService] Malformed docker_container_change payload, skipping:', payload);
      return;
    }

    try {
      const eventType = parsed.event_type as string;
      const host = parsed.host as string;
      const containerId = parsed.container_id as string;
      const eventAt = new Date(parsed.at as string).toISOString();

      // Handle destroy BEFORE the null-compose guard — destroy events have labels: {}
      // which produces compose_project: null. We must scan stackContainers to find the entry.
      if (eventType === 'destroy') {
        for (const [sk, byContainer] of this.stackContainers) {
          const entityKey = `${host}/${containerId}`;
          if (byContainer.has(entityKey)) {
            byContainer.delete(entityKey);
            const [stackHost, ...stackParts] = sk.split('/');
            const stackName = stackParts.join('/');
            if (byContainer.size === 0) {
              this.stackContainers.delete(sk);
            }
            this.broadcastStack(stackHost, stackName, eventAt);
            return;
          }
        }
        // Non-compose container destroyed — nothing to broadcast
        return;
      }

      const composeProject = (parsed.compose_project as string | null) ?? null;

      if (composeProject === null) {
        // Non-compose container upsert — not part of any stack, ignore
        return;
      }

      const sk = stackKey(host, composeProject);

      if (eventType === 'upsert') {
        const inv = notifyPayloadToInventory(parsed);
        let byContainer = this.stackContainers.get(sk);
        if (!byContainer) {
          byContainer = new Map();
          this.stackContainers.set(sk, byContainer);
        }
        byContainer.set(`${inv.host}/${inv.containerId}`, inv);
      }

      this.broadcastStack(host, composeProject, eventAt);
    } catch (err) {
      console.error('[StackStatusBroadcastService] Failed to process docker_container_change payload:', err);
    }
  }

  private handleDeployChange(payload?: string): void {
    if (!payload) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      console.error('[StackStatusBroadcastService] Malformed deploy_change payload, skipping:', payload);
      return;
    }

    try {
      const stack = parsed.stack as string;
      const host = parsed.host as string;
      if (typeof stack !== 'string' || typeof host !== 'string') {
        throw new Error('Invalid deploy_change payload: missing stack or host');
      }
      for (const cb of this.subscribers) {
        try {
          cb({ type: 'deploy_changed', stack, host });
        } catch (err) {
          console.error('[StackStatusBroadcastService] Subscriber callback failed:', err);
        }
      }
    } catch (err) {
      console.error('[StackStatusBroadcastService] Failed to process deploy_change payload:', err);
    }
  }

  private cleanupListenerClient(): void {
    if (this.listenerClient) {
      this.listenerClient.removeAllListeners();
      try {
        this.listenerClient.release();
      } catch {
        // best-effort release
      }
      this.listenerClient = null;
    }
  }

  private stopListening(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Reset so a later start() gets a clean slate (no stuck reconnect, no reconnect-branch).
    this.reconnecting = false;
    this.reconnectFailures = 0;
    this.isFirstConnect = true;
    this.cleanupListenerClient();
  }

  async stop(): Promise<void> {
    this.stopListening();
    this.subscribers.clear();
  }
}

export const stackStatusBroadcastService = new StackStatusBroadcastService();

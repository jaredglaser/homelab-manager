import type { PoolClient } from 'pg';
import type { DockerContainerInventory } from '@/types/docker-inventory';
import type { StackContainer } from '@/types/stacks';
import type { DockerContainerEventRow } from '@/lib/database/repositories/docker-container-event-repository';
import { notifyPayloadToInventory, rowToInventory } from '@/lib/docker/docker-inventory-broadcast-service';

/** A live stack status row derived from container inventory. */
export interface StackStatusRow {
  stack: string;
  host: string;
  containers: StackContainer[];
  updated_at: Date;
}

/** Discriminated union for events sent to SSE subscribers. */
export type StackBroadcastEvent =
  | { type: 'status'; entries: StackStatusRow[] }
  | { type: 'deploy_changed'; stack: string; host: string };

type StackBroadcastCallback = (event: StackBroadcastEvent) => void;

export interface StackStatusBroadcastServiceDeps {
  getPoolClient?: () => Promise<PoolClient>;
  loadSnapshot?: () => Promise<DockerContainerInventory[]>;
}

function toStackContainer(inv: DockerContainerInventory): StackContainer {
  return {
    id: inv.containerId,
    name: inv.name,
    status: inv.state,
    image: inv.image,
  };
}

function toStackRow(host: string, stack: string, containers: DockerContainerInventory[]): StackStatusRow {
  return {
    host,
    stack,
    containers: containers.map(toStackContainer),
    updated_at: new Date(Math.max(...containers.map((c) => c.updatedAt.getTime()))),
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

async function defaultLoadSnapshot(): Promise<DockerContainerInventory[]> {
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
    .filter((row) => row.eventType !== 'destroy')
    .map(rowToInventory);
}

/**
 * Group a flat list of container inventory items into stack rows.
 * Containers with null composeProject are excluded — they belong to no stack.
 */
function inventoryToStackRows(containers: DockerContainerInventory[]): StackStatusRow[] {
  const byStack = new Map<string, DockerContainerInventory[]>();
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
    toStackRow(group[0].host, group[0].composeProject!, group),
  );
}

/**
 * Server-side broadcast service for stack status changes.
 *
 * Derives stack state from docker_container_events grouped by compose_project.
 * Listens on two PostgreSQL NOTIFY channels:
 *   - 'docker_container_change' — triggers stack snapshot re-derivation for the affected stack.
 *   - 'deploy_change' — forwards deploy lifecycle events as-is.
 *
 * Auto-starts on first subscriber, auto-stops on last unsubscribe.
 */
export class StackStatusBroadcastService {
  private subscribers = new Set<StackBroadcastCallback>();
  private listenerClient: PoolClient | null = null;
  private stopped = true;
  private reconnecting = false;

  /** In-memory map from 'host/stack' → per-container inventory for that stack. */
  private readonly stackContainers = new Map<string, Map<string, DockerContainerInventory>>();

  private readonly getPoolClient: () => Promise<PoolClient>;
  private readonly loadSnapshot: () => Promise<DockerContainerInventory[]>;

  constructor(deps: StackStatusBroadcastServiceDeps = {}) {
    this.getPoolClient = deps.getPoolClient ?? defaultGetPoolClient;
    this.loadSnapshot = deps.loadSnapshot ?? defaultLoadSnapshot;
  }

  subscribe(callback: StackBroadcastCallback): () => void {
    this.subscribers.add(callback);

    if (this.subscribers.size === 1) {
      this.startListening();
    }

    this.sendInit(callback);

    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.stopListening();
      }
    };
  }

  private async sendInit(callback: StackBroadcastCallback): Promise<void> {
    try {
      const containers = await this.loadSnapshot();
      // Seed in-memory state from snapshot
      this.rebuildFromSnapshot(containers);
      if (this.subscribers.has(callback)) {
        const entries = inventoryToStackRows(containers);
        callback({ type: 'status', entries });
      }
    } catch (error) {
      console.error('[StackStatusBroadcastService] Failed to send init:', error);
    }
  }

  /** Rebuild in-memory stackContainers from a fresh snapshot. */
  private rebuildFromSnapshot(containers: DockerContainerInventory[]): void {
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

        this.listenerClient = poolClient;

        this.listenerClient.on('notification', (msg) => {
          if (msg.channel === 'docker_container_change') {
            this.handleContainerChange(msg.payload);
          } else if (msg.channel === 'deploy_change') {
            this.handleDeployChange(msg.payload);
          }
        });

        this.listenerClient.on('error', (err) => {
          console.error('[StackStatusBroadcastService] Listener client error:', err);
          this.cleanupListenerClient();
          if (!this.stopped && this.subscribers.size > 0 && !this.reconnecting) {
            this.reconnecting = true;
            setTimeout(() => {
              this.reconnecting = false;
              if (!this.stopped && this.subscribers.size > 0) {
                this.startListening();
              }
            }, 5_000);
          }
        });

        await this.listenerClient.query('LISTEN docker_container_change');
        await this.listenerClient.query('LISTEN deploy_change');

        // Reload snapshot on reconnect to rebuild in-memory state
        try {
          const containers = await this.loadSnapshot();
          this.rebuildFromSnapshot(containers);
        } catch (err) {
          console.error('[StackStatusBroadcastService] Failed to reload snapshot on reconnect:', err);
        }

        return;
      } catch (error) {
        console.error('[StackStatusBroadcastService] Failed to start listener, retrying in 5s:', error);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
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
      const composeProject = (parsed.compose_project as string | null) ?? null;

      if (composeProject === null) {
        // Non-compose container — not part of any stack, ignore
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
      } else if (eventType === 'destroy') {
        const containerId = parsed.container_id as string;
        const byContainer = this.stackContainers.get(sk);
        if (byContainer) {
          byContainer.delete(`${host}/${containerId}`);
          if (byContainer.size === 0) {
            this.stackContainers.delete(sk);
          }
        }
      }

      // Broadcast updated snapshot for this specific stack
      const byContainer = this.stackContainers.get(sk);
      const stackGroup = byContainer ? Array.from(byContainer.values()) : [];
      const entry = stackGroup.length > 0
        ? toStackRow(host, composeProject, stackGroup)
        : { host, stack: composeProject, containers: [], updated_at: new Date() };

      const entries: StackStatusRow[] = [entry];
      for (const cb of this.subscribers) {
        try {
          cb({ type: 'status', entries });
        } catch (err) {
          console.error('[StackStatusBroadcastService] Subscriber callback failed:', err);
        }
      }
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
    this.cleanupListenerClient();
  }

  async stop(): Promise<void> {
    this.stopListening();
    this.subscribers.clear();
  }
}

export const stackStatusBroadcastService = new StackStatusBroadcastService();

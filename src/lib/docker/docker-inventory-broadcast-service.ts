import type { PoolClient } from 'pg';
import type { DockerContainerInventory, DockerInventoryBroadcastEvent } from '@/types/docker-inventory';
import type { DockerContainerEventRow } from '@/lib/database/repositories/docker-container-event-repository';

type InventoryBroadcastCallback = (event: DockerInventoryBroadcastEvent) => void;

export function rowToInventory(row: DockerContainerEventRow): DockerContainerInventory {
  return {
    host: row.host,
    containerId: row.containerId,
    name: row.name ?? '',
    image: row.image ?? '',
    state: row.state ?? 'unknown',
    composeProject: row.composeProject,
    serviceKey: row.serviceKey ?? '',
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    exitCode: row.exitCode,
    labels: row.labels ?? {},
    updatedAt: row.at,
  };
}

export function notifyPayloadToInventory(payload: Record<string, unknown>): DockerContainerInventory {
  return {
    host: payload.host as string,
    containerId: payload.container_id as string,
    name: (payload.name as string | null) ?? '',
    image: (payload.image as string | null) ?? '',
    state: (payload.state as DockerContainerInventory['state'] | null) ?? 'unknown',
    composeProject: (payload.compose_project as string | null) ?? null,
    serviceKey: (payload.service_key as string | null) ?? '',
    startedAt: payload.started_at ? new Date(payload.started_at as string) : null,
    finishedAt: payload.finished_at ? new Date(payload.finished_at as string) : null,
    exitCode: (payload.exit_code as number | null) ?? null,
    labels: {},
    updatedAt: new Date(payload.at as string),
  };
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
  const rows = await repo.getCurrentSnapshot();
  return rows
    .filter((row) => row.eventType !== 'destroy')
    .map(rowToInventory);
}

export interface DockerInventoryBroadcastServiceDeps {
  getPoolClient?: () => Promise<PoolClient>;
  loadSnapshot?: () => Promise<DockerContainerInventory[]>;
}

/**
 * Server-side broadcast service for container inventory changes.
 *
 * Listens on PostgreSQL NOTIFY channel 'docker_container_change'. On subscribe,
 * sends an init snapshot from the DB. On each NOTIFY, forwards the event directly
 * without a round-trip DB read — the NOTIFY payload carries the full event minus labels.
 *
 * Auto-starts on first subscriber, auto-stops on last unsubscribe.
 */
export class DockerInventoryBroadcastService {
  private subscribers = new Set<InventoryBroadcastCallback>();
  private listenerClient: PoolClient | null = null;
  private stopped = true;
  private reconnecting = false;
  private readonly getPoolClient: () => Promise<PoolClient>;
  private readonly loadSnapshot: () => Promise<DockerContainerInventory[]>;

  constructor(deps: DockerInventoryBroadcastServiceDeps = {}) {
    this.getPoolClient = deps.getPoolClient ?? defaultGetPoolClient;
    this.loadSnapshot = deps.loadSnapshot ?? defaultLoadSnapshot;
  }

  subscribe(callback: InventoryBroadcastCallback): () => void {
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

  private async sendInit(callback: InventoryBroadcastCallback): Promise<void> {
    try {
      const containers = await this.loadSnapshot();
      if (this.subscribers.has(callback)) {
        callback({ type: 'init', containers });
      }
    } catch (error) {
      console.error('[DockerInventoryBroadcastService] Failed to send init:', error);
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
            this.handleNotify(msg.payload);
          }
        });

        this.listenerClient.on('error', (err) => {
          console.error('[DockerInventoryBroadcastService] Listener client error:', err);
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
        return;
      } catch (error) {
        console.error('[DockerInventoryBroadcastService] Failed to start listener, retrying in 5s:', error);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  }

  private handleNotify(payload?: string): void {
    if (!payload) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      console.error('[DockerInventoryBroadcastService] Malformed NOTIFY payload, skipping:', payload);
      return;
    }

    try {
      const eventType = parsed.event_type as string;

      if (eventType === 'upsert') {
        const container = notifyPayloadToInventory(parsed);
        for (const cb of this.subscribers) {
          try {
            cb({ type: 'upsert', container });
          } catch (err) {
            console.error('[DockerInventoryBroadcastService] Subscriber callback failed:', err);
          }
        }
      } else if (eventType === 'destroy') {
        const host = parsed.host as string;
        const containerId = parsed.container_id as string;
        const at = new Date(parsed.at as string);
        for (const cb of this.subscribers) {
          try {
            cb({ type: 'destroy', host, containerId, at });
          } catch (err) {
            console.error('[DockerInventoryBroadcastService] Subscriber callback failed:', err);
          }
        }
      }
    } catch (err) {
      console.error('[DockerInventoryBroadcastService] Failed to process NOTIFY payload:', err);
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

export const dockerInventoryBroadcastService = new DockerInventoryBroadcastService();

import type { PoolClient } from 'pg';
import type { DockerInventorySnapshotContainer, DockerInventoryBroadcastEvent } from '@/types/docker-inventory';
import { zDockerInventoryBroadcastEvent } from '@/types/docker-inventory';
import type { DockerContainerEventUpsertRow } from '@/lib/database/repositories/docker-container-event-repository';
import { backoffDelayMs } from '@/lib/utils/backoff';

type InventoryBroadcastCallback = (event: DockerInventoryBroadcastEvent) => void;

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

export function rowToInventory(row: DockerContainerEventUpsertRow): DockerInventorySnapshotContainer {
  return {
    host: row.host,
    containerId: row.containerId,
    name: row.name,
    image: row.image,
    state: row.state,
    composeProject: row.composeProject,
    serviceKey: row.serviceKey ?? '',
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    exitCode: row.exitCode,
    labels: row.labels ?? {},
    updatedAt: row.at,
  };
}

/**
 * Convert a raw NOTIFY payload to DockerInventorySnapshotContainer.
 * Validates required fields and throws a descriptive error if they are missing.
 */
export function notifyPayloadToInventory(payload: Record<string, unknown>): DockerInventorySnapshotContainer {
  const host = payload.host;
  const containerId = payload.container_id;
  const eventType = payload.event_type;
  const at = payload.at;

  if (typeof host !== 'string' || !host) {
    throw new Error(`[DockerInventoryBroadcastService] NOTIFY payload missing required field 'host': ${JSON.stringify(payload)}`);
  }
  if (typeof containerId !== 'string' || !containerId) {
    throw new Error(`[DockerInventoryBroadcastService] NOTIFY payload missing required field 'container_id': ${JSON.stringify(payload)}`);
  }
  if (typeof eventType !== 'string' || !eventType) {
    throw new Error(`[DockerInventoryBroadcastService] NOTIFY payload missing required field 'event_type': ${JSON.stringify(payload)}`);
  }
  if (typeof at !== 'string' || !at) {
    throw new Error(`[DockerInventoryBroadcastService] NOTIFY payload missing required field 'at': ${JSON.stringify(payload)}`);
  }

  return {
    host,
    containerId,
    name: (payload.name as string | null) ?? '',
    image: (payload.image as string | null) ?? '',
    state: (payload.state as DockerInventorySnapshotContainer['state'] | null) ?? 'unknown',
    composeProject: (payload.compose_project as string | null) ?? null,
    serviceKey: (payload.service_key as string | null) ?? '',
    startedAt: payload.started_at ? new Date(payload.started_at as string) : null,
    finishedAt: payload.finished_at ? new Date(payload.finished_at as string) : null,
    exitCode: (payload.exit_code as number | null) ?? null,
    labels: {},
    updatedAt: new Date(at),
  };
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
  const rows = await repo.getCurrentSnapshot();
  return rows
    .filter((row): row is DockerContainerEventUpsertRow => row.eventType === 'upsert')
    .map(rowToInventory);
}

export interface DockerInventoryBroadcastServiceDeps {
  getPoolClient?: () => Promise<PoolClient>;
  loadSnapshot?: () => Promise<DockerInventorySnapshotContainer[]>;
}

/**
 * Server-side broadcast service for container inventory changes.
 *
 * Listens on PostgreSQL NOTIFY channel 'docker_container_change'. On subscribe,
 * sends an init snapshot from the DB. On each NOTIFY, forwards the event directly
 * without a round-trip DB read: the NOTIFY payload carries the full event minus labels.
 *
 * Ordering: LISTEN is issued before sendInit is called, so no NOTIFYs are lost
 * while the snapshot loads. However, a NOTIFY that fires during snapshot load
 * can be fanned out to subscribers before the init event, so subscribers must be
 * tolerant of receiving an upsert for a container already present in the init.
 *
 * Auto-starts on first subscriber, auto-stops on last unsubscribe.
 */
export class DockerInventoryBroadcastService {
  private subscribers = new Set<InventoryBroadcastCallback>();
  private listenerClient: PoolClient | null = null;
  private stopped = true;
  private reconnecting = false;
  private reconnectFailures = 0;
  /** Timer reference so stop() can cancel a pending reconnect. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly getPoolClient: () => Promise<PoolClient>;
  private readonly loadSnapshot: () => Promise<DockerInventorySnapshotContainer[]>;

  constructor(deps: DockerInventoryBroadcastServiceDeps = {}) {
    this.getPoolClient = deps.getPoolClient ?? defaultGetPoolClient;
    this.loadSnapshot = deps.loadSnapshot ?? defaultLoadSnapshot;
  }

  subscribe(callback: InventoryBroadcastCallback): () => void {
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

        // Bind handlers to this specific client so a stale handler firing after
        // the client has been replaced cannot mutate shared state for the new one.
        const currentClient = poolClient;
        this.listenerClient = currentClient;

        currentClient.on('notification', (msg) => {
          if (this.listenerClient !== currentClient) return;
          if (msg.channel === 'docker_container_change') {
            this.handleNotify(msg.payload);
          }
        });

        currentClient.on('error', (err) => {
          console.error('[DockerInventoryBroadcastService] Listener client error:', err);
          if (this.listenerClient !== currentClient) {
            // Stale handler for a replaced client: do not touch shared state.
            return;
          }
          this.cleanupListenerClient();
          if (!this.stopped && this.subscribers.size > 0 && !this.reconnecting) {
            this.reconnecting = true;
            const delay = backoffDelayMs(this.reconnectFailures, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS });
            if (this.reconnectFailures === 0) {
              console.error(`[DockerInventoryBroadcastService] DB connection lost, reconnecting (delay ${delay}ms)`);
            } else if (this.reconnectFailures % 10 === 0) {
              console.warn(`[DockerInventoryBroadcastService] Still reconnecting after ${this.reconnectFailures} attempts (delay ${delay}ms)`);
            } else {
              console.debug(`[DockerInventoryBroadcastService] Reconnect attempt ${this.reconnectFailures + 1} (delay ${delay}ms)`);
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

        await currentClient.query('LISTEN docker_container_change');
        this.reconnectFailures = 0; // Reset backoff on successful connect
        return;
      } catch (error) {
        const delay = backoffDelayMs(this.reconnectFailures, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS });
        console.error(`[DockerInventoryBroadcastService] Failed to start listener, retrying in ${delay}ms:`, error);
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
      let candidate: DockerInventoryBroadcastEvent | null = null;

      if (eventType === 'upsert') {
        const container = notifyPayloadToInventory(parsed);
        candidate = { type: 'upsert', container };
      } else if (eventType === 'destroy') {
        const host = parsed.host as string;
        const containerId = parsed.container_id as string;
        const at = new Date(parsed.at as string);
        candidate = { type: 'destroy', host, containerId, at };
      } else {
        // Unknown event_type: drop silently; NOTIFY channel is tightly scoped.
        return;
      }

      // Validate before fan-out: a malformed payload must never reach subscribers.
      const result = zDockerInventoryBroadcastEvent.safeParse(candidate);
      if (!result.success) {
        console.error(
          '[DockerInventoryBroadcastService] NOTIFY payload failed schema validation, dropping:',
          result.error.issues,
        );
        return;
      }

      for (const cb of this.subscribers) {
        try {
          cb(result.data);
        } catch (err) {
          console.error('[DockerInventoryBroadcastService] Subscriber callback failed:', err);
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Reset so a later start() gets a clean slate (no stuck reconnect).
    this.reconnecting = false;
    this.reconnectFailures = 0;
    this.cleanupListenerClient();
  }

  async stop(): Promise<void> {
    this.stopListening();
    this.subscribers.clear();
  }
}

export const dockerInventoryBroadcastService = new DockerInventoryBroadcastService();

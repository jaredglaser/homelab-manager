import type { PoolClient } from 'pg';
import type { ZFSHostHealth } from '@/types/zfs';
import { backoffDelayMs } from '@/lib/utils/backoff';
import { ZFS_HEALTH_NOTIFY_CHANNEL } from '@/lib/database/repositories/zfs-health-repository';

export interface ZfsHealthSnapshot {
  hosts: ZFSHostHealth[];
}

type HealthSnapshotCallback = (snapshot: ZfsHealthSnapshot) => void;

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

async function defaultGetPoolClient(): Promise<PoolClient> {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  return client.getPool().connect();
}

async function defaultLoadSnapshot(): Promise<ZfsHealthSnapshot> {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { ZfsHealthRepository } = await import('@/lib/database/repositories/zfs-health-repository');
  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  return { hosts: await new ZfsHealthRepository(client.getPool()).list() };
}

export interface ZfsHealthBroadcastServiceDeps {
  getPoolClient?: () => Promise<PoolClient>;
  loadSnapshot?: () => Promise<ZfsHealthSnapshot>;
}

/** Fans the worker's ZFS pool health out to browsers. Without the reload after each LISTEN, health written while the listener was down never reaches the page. */
export class ZfsHealthBroadcastService {
  private subscribers = new Set<HealthSnapshotCallback>();
  private listenerClient: PoolClient | null = null;
  private stopped = true;
  private listenGeneration = 0;
  private reconnecting = false;
  private reconnectFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly getPoolClient: () => Promise<PoolClient>;
  private readonly loadSnapshot: () => Promise<ZfsHealthSnapshot>;
  private loadSeq = 0;
  private deliveredSeq = 0;

  constructor(deps: ZfsHealthBroadcastServiceDeps = {}) {
    this.getPoolClient = deps.getPoolClient ?? defaultGetPoolClient;
    this.loadSnapshot = deps.loadSnapshot ?? defaultLoadSnapshot;
  }

  subscribe(callback: HealthSnapshotCallback): () => void {
    this.subscribers.add(callback);

    if (this.subscribers.size === 1) {
      void this.startListening();
    } else {
      this.deliver(() => [callback]);
    }

    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.stopListening();
      }
    };
  }

  /**
   * Loads run independently, so one that never settles (a half-open connection) blocks nothing,
   * and a result older than the last one delivered is dropped.
   */
  private deliver(targets: () => Iterable<HealthSnapshotCallback>): void {
    const seq = ++this.loadSeq;
    void this.loadSnapshot().then(
      (snapshot) => {
        if (seq < this.deliveredSeq) return;
        this.deliveredSeq = seq;
        for (const cb of [...targets()]) {
          if (!this.subscribers.has(cb)) continue;
          try {
            cb(snapshot);
          } catch (err) {
            console.error('[ZfsHealthBroadcastService] Subscriber callback failed:', err);
          }
        }
      },
      (err: unknown) => {
        console.error('[ZfsHealthBroadcastService] Failed to load snapshot:', err);
      },
    );
  }

  private async startListening(): Promise<void> {
    this.stopped = false;
    const generation = ++this.listenGeneration;

    while (!this.stopped && generation === this.listenGeneration) {
      try {
        const poolClient = await this.getPoolClient();

        if (this.stopped || generation !== this.listenGeneration) {
          try { poolClient.release(); } catch { /* best-effort */ }
          return;
        }

        const currentClient = poolClient;
        this.listenerClient = currentClient;

        currentClient.on('notification', (msg) => {
          if (this.listenerClient !== currentClient) return;
          if (msg.channel === ZFS_HEALTH_NOTIFY_CHANNEL) {
            this.handleNotify();
          }
        });

        currentClient.on('error', (err) => {
          console.error('[ZfsHealthBroadcastService] Listener client error:', err);
          if (this.listenerClient !== currentClient) return;
          this.cleanupListenerClient();
          if (!this.stopped && this.subscribers.size > 0 && !this.reconnecting) {
            this.reconnecting = true;
            const delay = backoffDelayMs(this.reconnectFailures, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS });
            console.error(`[ZfsHealthBroadcastService] DB connection lost, reconnecting in ${delay}ms`);
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

        await currentClient.query(`LISTEN ${ZFS_HEALTH_NOTIFY_CHANNEL}`);
        this.reconnectFailures = 0;
        this.deliver(() => this.subscribers);
        return;
      } catch (err) {
        if (generation !== this.listenGeneration) return;
        const delay = backoffDelayMs(this.reconnectFailures, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS });
        console.error(`[ZfsHealthBroadcastService] Failed to start listener, retrying in ${delay}ms:`, err);
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

  private handleNotify(): void {
    this.deliver(() => this.subscribers);
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
    this.reconnecting = false;
    this.reconnectFailures = 0;
    this.cleanupListenerClient();
  }

  async stop(): Promise<void> {
    this.stopListening();
    this.subscribers.clear();
  }
}

export const zfsHealthBroadcastService = new ZfsHealthBroadcastService();

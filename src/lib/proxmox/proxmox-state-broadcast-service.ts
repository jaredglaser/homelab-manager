import type { PoolClient } from 'pg';
import type { ProxmoxCollectorState } from '@/types/proxmox';
import { backoffDelayMs } from '@/lib/utils/backoff';
import { PROXMOX_STATE_NOTIFY_CHANNEL } from '@/lib/database/repositories/proxmox-state-repository';

export interface ProxmoxStateSnapshot {
  connections: ProxmoxCollectorState[];
}

type StateSnapshotCallback = (snapshot: ProxmoxStateSnapshot) => void;

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

async function defaultGetPoolClient(): Promise<PoolClient> {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  return client.getPool().connect();
}

async function defaultLoadSnapshot(): Promise<ProxmoxStateSnapshot> {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { ProxmoxStateRepository } = await import('@/lib/database/repositories/proxmox-state-repository');
  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  const repo = new ProxmoxStateRepository(client.getPool());
  return { connections: await repo.list() };
}

export interface ProxmoxStateBroadcastServiceDeps {
  getPoolClient?: () => Promise<PoolClient>;
  loadSnapshot?: () => Promise<ProxmoxStateSnapshot>;
}

/**
 * Server-side broadcast of the worker's Proxmox collector state. Listens on 'proxmox_state_change'
 * (a trigger on proxmox_collector_state), sends the whole table on subscribe and again on each NOTIFY.
 * The web server never contacts Proxmox itself. Auto-starts on first subscriber, auto-stops on last unsubscribe.
 */
export class ProxmoxStateBroadcastService {
  private subscribers = new Set<StateSnapshotCallback>();
  private listenerClient: PoolClient | null = null;
  private stopped = true;
  private listenGeneration = 0;
  private reconnecting = false;
  private reconnectFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly getPoolClient: () => Promise<PoolClient>;
  private readonly loadSnapshot: () => Promise<ProxmoxStateSnapshot>;

  constructor(deps: ProxmoxStateBroadcastServiceDeps = {}) {
    this.getPoolClient = deps.getPoolClient ?? defaultGetPoolClient;
    this.loadSnapshot = deps.loadSnapshot ?? defaultLoadSnapshot;
  }

  subscribe(callback: StateSnapshotCallback): () => void {
    this.subscribers.add(callback);

    if (this.subscribers.size === 1) {
      void this.startListening().then(() => this.sendSnapshot(callback));
    } else {
      void this.sendSnapshot(callback);
    }

    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.stopListening();
      }
    };
  }

  private async sendSnapshot(callback: StateSnapshotCallback): Promise<void> {
    try {
      const snapshot = await this.loadSnapshot();
      if (this.subscribers.has(callback)) {
        callback(snapshot);
      }
    } catch (err) {
      console.error('[ProxmoxStateBroadcastService] Failed to load snapshot:', err);
    }
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
          if (msg.channel === PROXMOX_STATE_NOTIFY_CHANNEL) {
            this.handleNotify();
          }
        });

        currentClient.on('error', (err) => {
          console.error('[ProxmoxStateBroadcastService] Listener client error:', err);
          if (this.listenerClient !== currentClient) return;
          this.cleanupListenerClient();
          if (!this.stopped && this.subscribers.size > 0 && !this.reconnecting) {
            this.reconnecting = true;
            const delay = backoffDelayMs(this.reconnectFailures, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS });
            console.error(`[ProxmoxStateBroadcastService] DB connection lost, reconnecting in ${delay}ms`);
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

        await currentClient.query(`LISTEN ${PROXMOX_STATE_NOTIFY_CHANNEL}`);
        this.reconnectFailures = 0;
        return;
      } catch (err) {
        if (generation !== this.listenGeneration) return;
        const delay = backoffDelayMs(this.reconnectFailures, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS });
        console.error(`[ProxmoxStateBroadcastService] Failed to start listener, retrying in ${delay}ms:`, err);
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
    void this.loadSnapshot()
      .then((snapshot) => {
        for (const cb of this.subscribers) {
          try {
            cb(snapshot);
          } catch (err) {
            console.error('[ProxmoxStateBroadcastService] Subscriber callback failed:', err);
          }
        }
      })
      .catch((err) => {
        console.error('[ProxmoxStateBroadcastService] Failed to reload snapshot after NOTIFY:', err);
      });
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

export const proxmoxStateBroadcastService = new ProxmoxStateBroadcastService();

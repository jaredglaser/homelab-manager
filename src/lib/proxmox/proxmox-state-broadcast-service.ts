import type { PoolClient } from 'pg';
import type { ProxmoxCollectorStateView } from '@/types/proxmox';
import { backoffDelayMs } from '@/lib/utils/backoff';
import { PROXMOX_STATE_NOTIFY_CHANNEL } from '@/lib/database/repositories/proxmox-state-repository';
import { PROXMOX_CONNECTIONS_NOTIFY_CHANNEL } from '@/lib/database/repositories/proxmox-connection-repository';

// A connection saved while the worker is down must still replace "not set up" on the page.
const CHANNELS = [PROXMOX_STATE_NOTIFY_CHANNEL, PROXMOX_CONNECTIONS_NOTIFY_CHANNEL];

export interface ProxmoxStateSnapshot {
  connections: ProxmoxCollectorStateView[];
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
  const connections = await repo.list();
  return {
    connections: connections.map(({ connectionId, host, port, state, lastSuccessAt, updatedAt }) => (
      { connectionId, host, port, state, lastSuccessAt, updatedAt }
    )),
  };
}

export interface ProxmoxStateBroadcastServiceDeps {
  getPoolClient?: () => Promise<PoolClient>;
  loadSnapshot?: () => Promise<ProxmoxStateSnapshot>;
}

/** Fans the worker's Proxmox state out to browsers. Without the reload after each LISTEN, a state written while the listener was down never reaches the page. */
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
  private loadSeq = 0;
  private deliveredSeq = 0;

  constructor(deps: ProxmoxStateBroadcastServiceDeps = {}) {
    this.getPoolClient = deps.getPoolClient ?? defaultGetPoolClient;
    this.loadSnapshot = deps.loadSnapshot ?? defaultLoadSnapshot;
  }

  subscribe(callback: StateSnapshotCallback): () => void {
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
  private deliver(targets: () => Iterable<StateSnapshotCallback>): void {
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
            console.error('[ProxmoxStateBroadcastService] Subscriber callback failed:', err);
          }
        }
      },
      (err: unknown) => {
        console.error('[ProxmoxStateBroadcastService] Failed to load snapshot:', err);
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
          if (CHANNELS.includes(msg.channel)) {
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

        for (const channel of CHANNELS) await currentClient.query(`LISTEN ${channel}`);
        this.reconnectFailures = 0;
        this.deliver(() => this.subscribers);
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

export const proxmoxStateBroadcastService = new ProxmoxStateBroadcastService();

import type { PoolClient } from 'pg';
import { AGENT_INVENTORY_NOTIFY_CHANNEL } from '@/lib/hosts/agent-inventory';
import { buildAgentInventorySnapshot } from '@/lib/hosts/agent-inventory';
import type { AgentInventorySnapshot } from '@/lib/hosts/agent-inventory';
import { backoffDelayMs } from '@/lib/utils/backoff';
import { HOSTS_NOTIFY_CHANNEL } from '@/lib/database/repositories/host-repository';

type InventorySnapshotCallback = (snapshot: AgentInventorySnapshot) => void;

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

async function defaultGetPoolClient(): Promise<PoolClient> {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  return client.getPool().connect();
}

async function defaultLoadSnapshot(): Promise<AgentInventorySnapshot> {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { HostRepository } = await import('@/lib/database/repositories/host-repository');
  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  const repo = new HostRepository(client.getPool());
  return buildAgentInventorySnapshot(await repo.findAll());
}

export interface AgentInventoryBroadcastServiceDeps {
  getPoolClient?: () => Promise<PoolClient>;
  loadSnapshot?: () => Promise<AgentInventorySnapshot>;
}

/**
 * Server-side broadcast service for the agent inventory snapshot.
 *
 * Listens on pg NOTIFY channels for sweep completions ('agent_inventory_change',
 * fired by the worker's sweeper) and host mutations ('managed_hosts_change',
 * fired by HostRepository). On subscribe it loads a snapshot from managed_hosts
 * immediately; on each NOTIFY it reloads and fans the full snapshot out.
 * Probing happens only in the worker; this service does zero network I/O to
 * agents, so subscriber count never scales probes.
 *
 * Auto-starts on first subscriber, auto-stops on last unsubscribe.
 */
export class AgentInventoryBroadcastService {
  private subscribers = new Set<InventorySnapshotCallback>();
  private listenerClient: PoolClient | null = null;
  private stopped = true;
  private reconnecting = false;
  private reconnectFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly getPoolClient: () => Promise<PoolClient>;
  private readonly loadSnapshot: () => Promise<AgentInventorySnapshot>;

  constructor(deps: AgentInventoryBroadcastServiceDeps = {}) {
    this.getPoolClient = deps.getPoolClient ?? defaultGetPoolClient;
    this.loadSnapshot = deps.loadSnapshot ?? defaultLoadSnapshot;
  }

  subscribe(callback: InventorySnapshotCallback): () => void {
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

  private async sendSnapshot(callback: InventorySnapshotCallback): Promise<void> {
    try {
      const snapshot = await this.loadSnapshot();
      if (this.subscribers.has(callback)) {
        callback(snapshot);
      }
    } catch (err) {
      console.error('[AgentInventoryBroadcastService] Failed to load snapshot:', err);
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

        const currentClient = poolClient;
        this.listenerClient = currentClient;

        currentClient.on('notification', (msg) => {
          if (this.listenerClient !== currentClient) return;
          if (msg.channel === AGENT_INVENTORY_NOTIFY_CHANNEL || msg.channel === HOSTS_NOTIFY_CHANNEL) {
            this.handleNotify();
          }
        });

        currentClient.on('error', (err) => {
          console.error('[AgentInventoryBroadcastService] Listener client error:', err);
          if (this.listenerClient !== currentClient) return;
          this.cleanupListenerClient();
          if (!this.stopped && this.subscribers.size > 0 && !this.reconnecting) {
            this.reconnecting = true;
            const delay = backoffDelayMs(this.reconnectFailures, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS });
            console.error(`[AgentInventoryBroadcastService] DB connection lost, reconnecting in ${delay}ms`);
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

        await currentClient.query(`LISTEN ${AGENT_INVENTORY_NOTIFY_CHANNEL}`);
        await currentClient.query(`LISTEN ${HOSTS_NOTIFY_CHANNEL}`);
        this.reconnectFailures = 0;
        return;
      } catch (err) {
        const delay = backoffDelayMs(this.reconnectFailures, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS });
        console.error(`[AgentInventoryBroadcastService] Failed to start listener, retrying in ${delay}ms:`, err);
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
            console.error('[AgentInventoryBroadcastService] Subscriber callback failed:', err);
          }
        }
      })
      .catch((err) => {
        console.error('[AgentInventoryBroadcastService] Failed to reload snapshot after NOTIFY:', err);
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

export const agentInventoryBroadcastService = new AgentInventoryBroadcastService();

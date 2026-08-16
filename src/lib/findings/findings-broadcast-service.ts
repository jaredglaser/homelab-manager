import type { Pool, PoolClient } from 'pg';
import type { Finding } from '@/lib/findings/types';
import { backoffDelayMs } from '@/lib/utils/backoff';

export type FindingsBroadcastEvent =
  | { type: 'init'; findings: Finding[] }
  | { type: 'upsert'; finding: Finding };

type FindingsBroadcastCallback = (event: FindingsBroadcastEvent) => void;

export interface FindingsBroadcastServiceDeps {
  getPoolClient?: () => Promise<PoolClient>;
  loadRecent?: () => Promise<Finding[]>;
  getById?: (id: number) => Promise<Finding | null>;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
const INIT_SNAPSHOT_LIMIT = 200;

async function getPool(): Promise<Pool> {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  return client.getPool();
}

async function defaultGetPoolClient(): Promise<PoolClient> {
  const pool = await getPool();
  return pool.connect();
}

async function defaultLoadRecent(): Promise<Finding[]> {
  const pool = await getPool();
  const { FindingsRepository } = await import('@/lib/database/repositories/findings-repository');
  return new FindingsRepository(pool).listRecent(INIT_SNAPSHOT_LIMIT);
}

async function defaultGetById(id: number): Promise<Finding | null> {
  const pool = await getPool();
  const { FindingsRepository } = await import('@/lib/database/repositories/findings-repository');
  return new FindingsRepository(pool).getById(id);
}

/**
 * Server-side broadcast service for findings.
 *
 * Listens on 'finding_change' (migration 039), whose payload carries routing keys
 * only (id, op, subject_kind, subject_id, severity, status), then re-reads the full
 * row by id and forwards it as an upsert. Auto-starts on first subscriber, auto-stops
 * on last unsubscribe.
 */
export class FindingsBroadcastService {
  private subscribers = new Set<FindingsBroadcastCallback>();
  private listenerClient: PoolClient | null = null;
  private stopped = true;
  private reconnecting = false;
  private reconnectFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly getPoolClient: () => Promise<PoolClient>;
  private readonly loadRecent: () => Promise<Finding[]>;
  private readonly getById: (id: number) => Promise<Finding | null>;

  constructor(deps: FindingsBroadcastServiceDeps = {}) {
    this.getPoolClient = deps.getPoolClient ?? defaultGetPoolClient;
    this.loadRecent = deps.loadRecent ?? defaultLoadRecent;
    this.getById = deps.getById ?? defaultGetById;
  }

  subscribe(callback: FindingsBroadcastCallback): () => void {
    this.subscribers.add(callback);

    if (this.subscribers.size === 1) {
      // Await startListening before sendInit to ensure LISTEN is registered first.
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

  private async sendInit(callback: FindingsBroadcastCallback): Promise<void> {
    try {
      const findings = await this.loadRecent();
      if (this.subscribers.has(callback)) {
        callback({ type: 'init', findings });
      }
    } catch (error) {
      console.error('[FindingsBroadcastService] Failed to send init:', error);
    }
  }

  private async startListening(): Promise<void> {
    this.stopped = false;

    while (!this.stopped) {
      try {
        const poolClient = await this.getPoolClient();

        if (this.stopped) {
          try {
            poolClient.release();
          } catch {
            // best-effort release
          }
          return;
        }

        // Bind handlers to this specific client so a stale handler firing after
        // the client has been replaced cannot mutate shared state for the new one.
        const currentClient = poolClient;
        this.listenerClient = currentClient;

        currentClient.on('notification', (msg) => {
          if (this.listenerClient !== currentClient) return;
          if (msg.channel === 'finding_change') {
            void this.handleFindingChange(msg.payload);
          }
        });

        currentClient.on('error', (err) => {
          console.error('[FindingsBroadcastService] Listener client error:', err);
          if (this.listenerClient !== currentClient) {
            return;
          }
          this.cleanupListenerClient();
          if (!this.stopped && this.subscribers.size > 0 && !this.reconnecting) {
            this.reconnecting = true;
            const delay = backoffDelayMs(this.reconnectFailures, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS });
            if (this.reconnectFailures === 0) {
              console.error(`[FindingsBroadcastService] DB connection lost, reconnecting (delay ${delay}ms)`);
            } else if (this.reconnectFailures % 10 === 0) {
              console.warn(`[FindingsBroadcastService] Still reconnecting after ${this.reconnectFailures} attempts (delay ${delay}ms)`);
            } else {
              console.debug(`[FindingsBroadcastService] Reconnect attempt ${this.reconnectFailures + 1} (delay ${delay}ms)`);
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

        await currentClient.query('LISTEN finding_change');
        this.reconnectFailures = 0;
        return;
      } catch (error) {
        const delay = backoffDelayMs(this.reconnectFailures, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS });
        console.error(`[FindingsBroadcastService] Failed to start listener, retrying in ${delay}ms:`, error);
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

  private async handleFindingChange(payload?: string): Promise<void> {
    if (!payload) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      console.error('[FindingsBroadcastService] Malformed finding_change payload, skipping:', payload);
      return;
    }

    const id = Number(parsed.id);
    if (!Number.isFinite(id)) {
      console.error('[FindingsBroadcastService] finding_change payload missing a numeric id, skipping:', payload);
      return;
    }

    try {
      const finding = await this.getById(id);
      if (!finding) return;
      for (const cb of this.subscribers) {
        try {
          cb({ type: 'upsert', finding });
        } catch (err) {
          console.error('[FindingsBroadcastService] Subscriber callback failed:', err);
        }
      }
    } catch (err) {
      console.error('[FindingsBroadcastService] Failed to re-read finding after notify:', err);
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
    this.reconnecting = false;
    this.reconnectFailures = 0;
    this.cleanupListenerClient();
  }

  async stop(): Promise<void> {
    this.stopListening();
    this.subscribers.clear();
  }
}

export const findingsBroadcastService = new FindingsBroadcastService();

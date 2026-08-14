import '@tanstack/react-start/server-only';
import type { PoolClient } from 'pg';
import type { AiAnalysisSnapshot } from '@/types/ai';
import { AI_ANALYSIS_NOTIFY_CHANNEL } from '@/lib/database/repositories/ai-analysis-repository';
import { backoffDelayMs } from '@/lib/utils/backoff';

type SnapshotCallback = (snapshot: AiAnalysisSnapshot) => void;

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
/**
 * A single analysis turn can file several observations in a row, each firing
 * its own NOTIFY. Coalescing them into one reload keeps a chatty fleet from
 * turning every finding into a full four-table read.
 */
const COALESCE_MS = 250;

export interface AiAnalysisBroadcastServiceDeps {
  getPoolClient?: () => Promise<PoolClient>;
  loadSnapshot?: () => Promise<AiAnalysisSnapshot>;
}

async function defaultGetPoolClient(): Promise<PoolClient> {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const client = await databaseConnectionManager.getClient(loadDatabaseConfig());
  return client.getPool().connect();
}

async function defaultLoadSnapshot(): Promise<AiAnalysisSnapshot> {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { AiAnalysisRepository } = await import('@/lib/database/repositories/ai-analysis-repository');
  const client = await databaseConnectionManager.getClient(loadDatabaseConfig());
  const repo = new AiAnalysisRepository(client.getPool());
  const [profiles, sessions, observations, alerts] = await Promise.all([
    repo.listProfiles(),
    repo.listSessions(),
    repo.listObservations(),
    repo.listAlerts(),
  ]);
  return { profiles, sessions, observations, alerts };
}

/**
 * Pushes the AI analysis snapshot to `/api/ai-analysis` subscribers whenever
 * the worker writes a profile, session, observation or alert.
 *
 * Reloads the whole snapshot on every change rather than diffing: the tables
 * are bounded by their list limits and a homelab fleet produces observations
 * at human pace, so a full read is cheaper than the state machine a diff needs.
 */
export class AiAnalysisBroadcastService {
  private readonly subscribers = new Set<SnapshotCallback>();
  private listenerClient: PoolClient | null = null;
  private stopped = true;
  private reconnectFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly getPoolClient: () => Promise<PoolClient>;
  private readonly loadSnapshot: () => Promise<AiAnalysisSnapshot>;

  constructor(deps: AiAnalysisBroadcastServiceDeps = {}) {
    this.getPoolClient = deps.getPoolClient ?? defaultGetPoolClient;
    this.loadSnapshot = deps.loadSnapshot ?? defaultLoadSnapshot;
  }

  subscribe(callback: SnapshotCallback): () => void {
    this.subscribers.add(callback);
    if (this.subscribers.size === 1) {
      void this.startListening().then(() => this.pushTo(callback));
    } else {
      void this.pushTo(callback);
    }

    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) this.stopListening();
    };
  }

  private async pushTo(callback: SnapshotCallback): Promise<void> {
    try {
      const snapshot = await this.loadSnapshot();
      if (this.subscribers.has(callback)) callback(snapshot);
    } catch (err) {
      console.error('[AiAnalysisBroadcastService] Snapshot load failed:', err);
    }
  }

  private async broadcast(): Promise<void> {
    if (this.subscribers.size === 0) return;
    try {
      const snapshot = await this.loadSnapshot();
      for (const callback of this.subscribers) callback(snapshot);
    } catch (err) {
      console.error('[AiAnalysisBroadcastService] Snapshot reload failed:', err);
    }
  }

  private scheduleBroadcast(): void {
    if (this.coalesceTimer !== null) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      void this.broadcast();
    }, COALESCE_MS);
  }

  private async startListening(): Promise<void> {
    this.stopped = false;

    let client: PoolClient;
    try {
      client = await this.getPoolClient();
    } catch (err) {
      console.error('[AiAnalysisBroadcastService] Failed to acquire listener client:', err);
      this.scheduleReconnect();
      return;
    }

    if (this.stopped) {
      this.releaseClient(client);
      return;
    }

    this.listenerClient = client;
    this.reconnectFailures = 0;

    client.on('notification', (message) => {
      if (this.listenerClient !== client) return;
      if (message.channel === AI_ANALYSIS_NOTIFY_CHANNEL) this.scheduleBroadcast();
    });

    client.on('error', (err) => {
      if (this.listenerClient !== client) return;
      console.error('[AiAnalysisBroadcastService] Listener client error:', err);
      this.listenerClient = null;
      this.releaseClient(client);
      this.scheduleReconnect();
    });

    try {
      await client.query(`LISTEN ${AI_ANALYSIS_NOTIFY_CHANNEL}`);
    } catch (err) {
      console.error('[AiAnalysisBroadcastService] LISTEN failed:', err);
      this.listenerClient = null;
      this.releaseClient(client);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.subscribers.size === 0 || this.reconnectTimer !== null) return;
    const delayMs = backoffDelayMs(this.reconnectFailures, {
      baseMs: BACKOFF_BASE_MS,
      capMs: BACKOFF_CAP_MS,
    });
    this.reconnectFailures += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped && this.subscribers.size > 0) void this.startListening();
    }, delayMs);
  }

  private releaseClient(client: PoolClient): void {
    try {
      client.removeAllListeners();
      client.release();
    } catch {
      // Best-effort: a client that already errored may refuse release.
    }
  }

  private stopListening(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    const client = this.listenerClient;
    this.listenerClient = null;
    if (client) {
      void client.query(`UNLISTEN ${AI_ANALYSIS_NOTIFY_CHANNEL}`).catch(() => {});
      this.releaseClient(client);
    }
  }
}

export const aiAnalysisBroadcastService = new AiAnalysisBroadcastService();

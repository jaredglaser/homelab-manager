import { Client, type ClientConfig } from 'pg';
import { EventEmitter } from 'events';
import { loadDatabaseConfig } from '@/lib/config/database-config';
import { loadInfluxDBConfig } from '@/lib/config/influxdb-config';
import { influxConnectionManager } from '@/lib/clients/influxdb-client';
import { InfluxStatsRepository } from '@/lib/database/repositories/influx-stats-repository';
import { EntityMetadataRepository } from '@/lib/database/repositories/entity-metadata-repository';
import { SettingsRepository } from '@/lib/database/repositories/settings-repository';
import { statsCache } from '@/lib/cache/stats-cache';
import { transformDockerStats } from '@/lib/transformers/docker-transformer';
import { transformZFSStats } from '@/lib/transformers/zfs-transformer';
import { databaseConnectionManager, type DatabaseConfig } from '@/lib/clients/database-client';

/** Events emitted by the subscription service */
export interface SubscriptionServiceEvents {
  stats_update: (source: 'docker' | 'zfs') => void;
  error: (error: Error) => void;
  connected: () => void;
  disconnected: () => void;
}

/**
 * Singleton service that polls InfluxDB for latest stats and updates the cache.
 * Also maintains a PostgreSQL LISTEN connection for settings change notifications.
 *
 * Replaces the previous LISTEN/NOTIFY-based approach for stats with polling,
 * since time-series data is now stored in InfluxDB (which has no pub/sub).
 *
 * Usage:
 *   await subscriptionService.start();
 *   subscriptionService.on('stats_update', (source) => { ... });
 */
class SubscriptionService extends EventEmitter {
  private pgClient: Client | null = null;
  private influxRepo: InfluxStatsRepository | null = null;
  private metadataRepo: EntityMetadataRepository | null = null;
  private settingsRepo: SettingsRepository | null = null;
  private dbConfig: DatabaseConfig | null = null;
  private isRunning = false;
  private startPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly baseReconnectDelay = 1000; // 1 second

  // Polling state
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs = 1000; // Poll InfluxDB every 1 second
  private lastDockerTimestamp: number | null = null;
  private lastZFSTimestamp: number | null = null;

  // Debug logging
  private _debugLogging = false;

  get isDebugLogging(): boolean {
    return this._debugLogging;
  }

  set debugLogging(enabled: boolean) {
    this._debugLogging = enabled;
  }

  private debugLog(message: string): void {
    if (this._debugLogging) {
      console.log(message);
    }
  }

  /**
   * Start the subscription service.
   * Connects to InfluxDB for polling and PostgreSQL for settings LISTEN.
   * Safe to call concurrently - subsequent calls await the first startup.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    // If startup is in progress, await it
    if (this.startPromise) {
      return this.startPromise;
    }

    // Start and store the promise so concurrent calls can await it
    this.startPromise = this.doStart();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    try {
      this.dbConfig = loadDatabaseConfig();
      await this.connect();
      this.isRunning = true;
      this.reconnectAttempts = 0;
    } catch (err) {
      console.error('[SubscriptionService] Failed to start:', err);
      throw err;
    }
  }

  private async connect(): Promise<void> {
    if (!this.dbConfig) {
      throw new Error('Config not loaded');
    }

    // Connect to InfluxDB for time-series queries
    const influxConfig = loadInfluxDBConfig();
    const influxClient = await influxConnectionManager.getClient(influxConfig);
    this.influxRepo = new InfluxStatsRepository(
      influxClient.getClient(),
      influxClient.getOrg(),
      influxClient.getBucket(),
    );

    // Connect to PostgreSQL for settings + entity metadata
    const dbClient = await databaseConnectionManager.getClient(this.dbConfig);
    const pool = dbClient.getPool();
    this.metadataRepo = new EntityMetadataRepository(pool);
    this.settingsRepo = new SettingsRepository(pool);

    // Set up PostgreSQL LISTEN for settings changes only
    const clientConfig: ClientConfig = {
      host: this.dbConfig.host,
      port: this.dbConfig.port,
      database: this.dbConfig.database,
      user: this.dbConfig.user,
      password: this.dbConfig.password,
    };

    if (this.dbConfig.ssl) {
      clientConfig.ssl = { rejectUnauthorized: false };
    }

    this.pgClient = new Client(clientConfig);

    this.pgClient.on('error', err => {
      console.error('[SubscriptionService] PG Client error:', err);
      this.emit('error', err);
      this.scheduleReconnect();
    });

    this.pgClient.on('end', () => {
      console.log('[SubscriptionService] PG connection ended');
      this.emit('disconnected');
      if (this.isRunning) {
        this.scheduleReconnect();
      }
    });

    // Handle settings change notifications (still via PostgreSQL LISTEN/NOTIFY)
    this.pgClient.on('notification', async msg => {
      if (msg.channel === 'settings_change' && msg.payload === 'developer/sseDebugLogging') {
        try {
          const value = await this.settingsRepo?.get('developer/sseDebugLogging');
          this.debugLogging = value === 'true';
        } catch {
          // DB read failed — keep current value
        }
      }
    });

    await this.pgClient.connect();
    console.log('[SubscriptionService] Connected to PostgreSQL for settings');

    await this.pgClient.query('LISTEN settings_change');

    // Load initial debug setting
    try {
      const value = await this.settingsRepo.get('developer/sseDebugLogging');
      this.debugLogging = value === 'true';
    } catch {
      // DB read failed — keep default (off)
    }

    // Load initial data from InfluxDB into cache
    await this.loadInitialData();

    // Start polling InfluxDB for stats updates
    this.startPolling();

    this.emit('connected');
  }

  private startPolling(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      this.poll().catch(err => {
        console.error('[SubscriptionService] Poll error:', err);
      });
    }, this.pollIntervalMs);

    this.debugLog('[SubscriptionService] Started polling InfluxDB');
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Poll InfluxDB for latest stats and update cache if data has changed.
   */
  private async poll(): Promise<void> {
    if (!this.influxRepo || !this.metadataRepo) return;

    try {
      // Poll Docker stats
      const t0 = performance.now();
      const dockerRows = await this.influxRepo.getLatestStats({ sourceName: 'docker' });
      const tDockerQuery = performance.now();

      if (dockerRows.length > 0) {
        // Check if data has changed by comparing latest timestamp
        const latestDockerTs = Math.max(...dockerRows.map(r => r.timestamp.getTime()));
        if (latestDockerTs !== this.lastDockerTimestamp) {
          this.lastDockerTimestamp = latestDockerTs;

          const entities = [...new Set(dockerRows.map(r => r.entity))];
          const metadata = await this.metadataRepo.getEntityMetadata('docker', entities);
          statsCache.updateDocker(transformDockerStats(dockerRows, metadata));

          this.debugLog(
            `[SubscriptionService] docker: ${dockerRows.length} rows` +
            ` (query=${(tDockerQuery - t0).toFixed(0)}ms)`
          );
          this.emit('stats_update', 'docker');
        }
      }

      // Poll ZFS stats
      const tZfsStart = performance.now();
      const zfsRows = await this.influxRepo.getLatestStats({ sourceName: 'zfs' });
      const tZfsQuery = performance.now();

      if (zfsRows.length > 0) {
        const latestZfsTs = Math.max(...zfsRows.map(r => r.timestamp.getTime()));
        if (latestZfsTs !== this.lastZFSTimestamp) {
          this.lastZFSTimestamp = latestZfsTs;

          statsCache.updateZFS(transformZFSStats(zfsRows));

          this.debugLog(
            `[SubscriptionService] zfs: ${zfsRows.length} rows` +
            ` (query=${(tZfsQuery - tZfsStart).toFixed(0)}ms)`
          );
          this.emit('stats_update', 'zfs');
        }
      }
    } catch (err) {
      console.error('[SubscriptionService] Failed to poll InfluxDB:', err);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async loadInitialData(): Promise<void> {
    if (!this.influxRepo || !this.metadataRepo) return;

    try {
      // Load Docker stats with metadata from InfluxDB
      const dockerRows = await this.influxRepo.getLatestStats({ sourceName: 'docker' });
      const dockerEntities = [...new Set(dockerRows.map(r => r.entity))];
      const dockerMetadata = await this.metadataRepo.getEntityMetadata('docker', dockerEntities);
      statsCache.updateDocker(transformDockerStats(dockerRows, dockerMetadata));
      if (dockerRows.length > 0) {
        this.lastDockerTimestamp = Math.max(...dockerRows.map(r => r.timestamp.getTime()));
      }
      console.log(`[SubscriptionService] Loaded ${dockerRows.length} Docker stat rows into cache`);

      // Load ZFS stats from InfluxDB
      const zfsRows = await this.influxRepo.getLatestStats({ sourceName: 'zfs' });
      statsCache.updateZFS(transformZFSStats(zfsRows));
      if (zfsRows.length > 0) {
        this.lastZFSTimestamp = Math.max(...zfsRows.map(r => r.timestamp.getTime()));
      }
      console.log(`[SubscriptionService] Loaded ${zfsRows.length} ZFS stat rows into cache`);
    } catch (err) {
      console.error('[SubscriptionService] Failed to load initial data:', err);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[SubscriptionService] Max reconnect attempts reached, giving up');
      this.isRunning = false;
      return;
    }

    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      30000 // Max 30 seconds
    );

    console.log(
      `[SubscriptionService] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1})`
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;

      try {
        await this.cleanup();
        await this.connect();
        this.reconnectAttempts = 0; // Reset on successful connect
      } catch (err) {
        console.error('[SubscriptionService] Reconnect failed:', err);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private async cleanup(): Promise<void> {
    this.stopPolling();

    if (this.pgClient) {
      try {
        await this.pgClient.end();
      } catch {
        // Ignore errors during cleanup
      }
      this.pgClient = null;
    }
  }

  /**
   * Stop the subscription service.
   * Closes connections and cleans up resources.
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    await this.cleanup();
    console.log('[SubscriptionService] Stopped');
  }

  /**
   * Check if the service is currently running and connected
   */
  isConnected(): boolean {
    return this.isRunning && this.influxRepo !== null;
  }

  /**
   * Get the stats cache (for access from server functions)
   */
  getCache(): typeof statsCache {
    return statsCache;
  }
}

/**
 * Singleton instance of the subscription service.
 * Use this to subscribe to stats updates from anywhere in the server.
 */
export const subscriptionService = new SubscriptionService();

import { Client, type ClientConfig } from 'pg';
import { EventEmitter } from 'events';
import { loadDatabaseConfig } from '@/lib/config/database-config';
import { StatsRepository } from '@/lib/database/repositories/stats-repository';
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
 * Singleton service that maintains a LISTEN connection to PostgreSQL
 * and updates the stats cache when NOTIFY is received.
 *
 * Usage:
 *   await subscriptionService.start();
 *   subscriptionService.on('stats_update', (source) => { ... });
 */
class SubscriptionService extends EventEmitter {
  private client: Client | null = null;
  private repository: StatsRepository | null = null;
  private config: DatabaseConfig | null = null;
  private isRunning = false;
  private startPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly baseReconnectDelay = 1000; // 1 second

  // Throttle state: emit at most once per interval per source
  private readonly emitThrottleMs = 1000; // 1 second between UI updates
  private lastEmitTime: Map<string, number> = new Map();
  private pendingEmit: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /**
   * Start the subscription service.
   * Connects to PostgreSQL, sets up LISTEN, and begins processing notifications.
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
      this.config = loadDatabaseConfig();
      await this.connect();
      this.isRunning = true;
      this.reconnectAttempts = 0;
    } catch (err) {
      console.error('[SubscriptionService] Failed to start:', err);
      throw err;
    }
  }

  private async connect(): Promise<void> {
    if (!this.config) {
      throw new Error('Config not loaded');
    }

    // Create a dedicated client for LISTEN (not from the pool)
    const clientConfig: ClientConfig = {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
    };

    if (this.config.ssl) {
      clientConfig.ssl = { rejectUnauthorized: false };
    }

    this.client = new Client(clientConfig);

    // Handle errors on the connection
    this.client.on('error', err => {
      console.error('[SubscriptionService] Client error:', err);
      this.emit('error', err);
      this.scheduleReconnect();
    });

    // Handle connection end
    this.client.on('end', () => {
      console.log('[SubscriptionService] Connection ended');
      this.emit('disconnected');
      if (this.isRunning) {
        this.scheduleReconnect();
      }
    });

    // Handle notifications
    this.client.on('notification', async msg => {
      if (msg.channel === 'stats_update') {
        const source = msg.payload as 'docker' | 'zfs';
        await this.handleNotification(source);
      }
    });

    // Connect
    await this.client.connect();
    console.log('[SubscriptionService] Connected to PostgreSQL');

    // Subscribe to notifications
    await this.client.query('LISTEN stats_update');
    console.log('[SubscriptionService] Listening for stats_update notifications');

    // Get a repository for querying
    const dbClient = await databaseConnectionManager.getClient(this.config);
    this.repository = new StatsRepository(dbClient.getPool());

    // Load initial data into cache
    await this.loadInitialData();

    this.emit('connected');
  }

  private async loadInitialData(): Promise<void> {
    if (!this.repository) return;

    try {
      // Load Docker stats
      const dockerRows = await this.repository.getLatestStats({ sourceName: 'docker' });
      statsCache.updateDocker(transformDockerStats(dockerRows));
      console.log(`[SubscriptionService] Loaded ${dockerRows.length} Docker stat rows into cache`);

      // Load ZFS stats
      const zfsRows = await this.repository.getLatestStats({ sourceName: 'zfs' });
      statsCache.updateZFS(transformZFSStats(zfsRows));
      console.log(`[SubscriptionService] Loaded ${zfsRows.length} ZFS stat rows into cache`);
    } catch (err) {
      console.error('[SubscriptionService] Failed to load initial data:', err);
    }
  }

  private async handleNotification(source: 'docker' | 'zfs'): Promise<void> {
    if (!this.repository) return;

    try {
      const rows = await this.repository.getLatestStats({ sourceName: source });

      // Always update cache immediately so data is fresh
      if (source === 'docker') {
        statsCache.updateDocker(transformDockerStats(rows));
      } else if (source === 'zfs') {
        statsCache.updateZFS(transformZFSStats(rows));
      }

      // Throttle UI updates: emit at most once per interval per source
      this.throttledEmit(source);
    } catch (err) {
      console.error(`[SubscriptionService] Failed to handle notification for ${source}:`, err);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Emit stats_update event with throttling.
   * Ensures UI updates happen at a consistent pace (~1/sec) even when
   * notifications arrive rapidly from multiple containers.
   */
  private throttledEmit(source: 'docker' | 'zfs'): void {
    const now = Date.now();
    const lastEmit = this.lastEmitTime.get(source) ?? 0;
    const elapsed = now - lastEmit;

    if (elapsed >= this.emitThrottleMs) {
      // Enough time has passed, emit immediately
      this.lastEmitTime.set(source, now);
      this.emit('stats_update', source);

      // Clear any pending trailing emit since we just emitted
      const pending = this.pendingEmit.get(source);
      if (pending) {
        clearTimeout(pending);
        this.pendingEmit.delete(source);
      }
    } else if (!this.pendingEmit.has(source)) {
      // Schedule a trailing emit to send latest data after throttle window
      const delay = this.emitThrottleMs - elapsed;
      const timer = setTimeout(() => {
        this.pendingEmit.delete(source);
        this.lastEmitTime.set(source, Date.now());
        this.emit('stats_update', source);
      }, delay);
      this.pendingEmit.set(source, timer);
    }
    // If already have a pending emit scheduled, do nothing - it will send latest data
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
    if (this.client) {
      try {
        await this.client.end();
      } catch {
        // Ignore errors during cleanup
      }
      this.client = null;
    }
  }

  /**
   * Stop the subscription service.
   * Closes the connection and cleans up resources.
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Clear any pending throttled emits
    for (const timer of this.pendingEmit.values()) {
      clearTimeout(timer);
    }
    this.pendingEmit.clear();

    await this.cleanup();
    console.log('[SubscriptionService] Stopped');
  }

  /**
   * Check if the service is currently running and connected
   */
  isConnected(): boolean {
    return this.isRunning && this.client !== null;
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

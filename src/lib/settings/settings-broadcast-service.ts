import type { PoolClient } from 'pg';
import type { SettingsSSEMessage } from '@/types/settings';

type SettingsCallback = (message: SettingsSSEMessage) => void;

/**
 * Server-side broadcast service for settings changes.
 *
 * Listens to PostgreSQL NOTIFY on the 'settings_change' channel and
 * broadcasts changes to all subscribed SSE clients. On subscribe,
 * sends the full settings state as an 'init' message - this handles
 * both startup sync and reconnection recovery.
 *
 * Auto-starts on first subscriber, auto-stops on last unsubscribe.
 */
class SettingsBroadcastService {
  private subscribers = new Set<SettingsCallback>();
  private listenerClient: PoolClient | null = null;
  private stopped = true;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * In-flight startListening() promise. Serializes concurrent callers
   * (e.g., a subscribe() and a reconnect timer firing simultaneously)
   * so we never end up with two pending pool.connect() calls leaking
   * a listenerClient.
   */
  private startInFlight: Promise<boolean> | null = null;

  subscribe(callback: SettingsCallback): () => void {
    this.subscribers.add(callback);

    if (this.subscribers.size === 1) {
      this.startListening();
    }

    // Send full state to new subscriber
    this.sendInit(callback);

    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.stopListening();
      }
    };
  }

  private async sendInit(callback: SettingsCallback): Promise<void> {
    try {
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');
      const { SettingsRepository } = await import(
        '@/lib/database/repositories/settings-repository'
      );

      const config = loadDatabaseConfig();
      const client = await databaseConnectionManager.getClient(config);
      const repo = new SettingsRepository(client.getPool());
      const all = await repo.getAll();

      // Only send if subscriber is still active
      if (this.subscribers.has(callback)) {
        callback({ type: 'init', settings: Object.fromEntries(all) });
      }
    } catch (error) {
      console.error('[SettingsBroadcastService] Failed to send init:', error);
    }
  }

  /** Attempt to establish the LISTEN connection. Returns true on success. */
  private startListening(): Promise<boolean> {
    if (this.startInFlight) return this.startInFlight;
    this.startInFlight = this.doStartListening().finally(() => {
      this.startInFlight = null;
    });
    return this.startInFlight;
  }

  private async doStartListening(): Promise<boolean> {
    this.stopped = false;
    let poolClient: PoolClient | null = null;

    try {
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');

      const config = loadDatabaseConfig();
      const client = await databaseConnectionManager.getClient(config);
      const pool = client.getPool();
      poolClient = await pool.connect();

      if (this.stopped) {
        try { poolClient.release(); } catch { /* best-effort */ }
        return false;
      }

      this.listenerClient = poolClient;

      this.listenerClient.on('notification', (msg) => {
        if (msg.channel === 'settings_change' && msg.payload) {
          this.handleChange(msg.payload);
        }
      });

      this.listenerClient.on('error', (err) => {
        console.error('[SettingsBroadcastService] Listener client error:', err);
        void this.cleanupListenerClient();
        if (!this.stopped && this.subscribers.size > 0 && !this.reconnecting) {
          this.reconnecting = true;
          this.scheduleReconnect();
        }
      });

      await this.listenerClient.query('LISTEN settings_change');
      return true;
    } catch (error) {
      console.error('[SettingsBroadcastService] Failed to start listener:', error);
      // If we acquired a poolClient before failing (e.g. LISTEN query threw),
      // make sure it's cleaned up so we don't leak a tracked listenerClient.
      if (poolClient && this.listenerClient === poolClient) {
        await this.cleanupListenerClient();
      } else if (poolClient) {
        try { poolClient.release(true); } catch { /* best-effort */ }
      }
      // Schedule a retry so the service recovers from initial connect failures
      // (matching the runtime error handler's behavior).
      if (!this.stopped && this.subscribers.size > 0 && !this.reconnecting) {
        this.reconnecting = true;
        this.scheduleReconnect();
      }
      return false;
    }
  }

  /** Re-send full settings state to every active subscriber. */
  private async resyncAllSubscribers(): Promise<void> {
    if (this.subscribers.size === 0) return;
    try {
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');
      const { SettingsRepository } = await import(
        '@/lib/database/repositories/settings-repository'
      );

      const config = loadDatabaseConfig();
      const client = await databaseConnectionManager.getClient(config);
      const repo = new SettingsRepository(client.getPool());
      const all = await repo.getAll();
      const message: SettingsSSEMessage = { type: 'init', settings: Object.fromEntries(all) };

      for (const cb of this.subscribers) {
        try {
          cb(message);
        } catch (err) {
          console.error('[SettingsBroadcastService] Subscriber callback failed during resync:', err);
        }
      }
    } catch (error) {
      console.error('[SettingsBroadcastService] Failed to resync subscribers:', error);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.stopped && this.subscribers.size > 0) {
        const ok = await this.startListening();
        if (ok) {
          this.reconnecting = false;
          // Settings may have changed during the disconnect window — push the
          // current state to all subscribers so their cached view is fresh.
          await this.resyncAllSubscribers();
        } else {
          // Still reconnecting — retry again after the same backoff.
          // Note: startListening() may have already scheduled a retry via its
          // own catch block; scheduleReconnect() is idempotent thanks to the
          // reconnectTimer guard, so calling it again is safe.
          this.scheduleReconnect();
        }
      } else {
        this.reconnecting = false;
      }
    }, 5_000);
  }

  private async handleChange(key: string): Promise<void> {
    try {
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');
      const { SettingsRepository } = await import(
        '@/lib/database/repositories/settings-repository'
      );

      const config = loadDatabaseConfig();
      const client = await databaseConnectionManager.getClient(config);
      const repo = new SettingsRepository(client.getPool());
      const value = await repo.get(key);

      if (value !== null) {
        const message: SettingsSSEMessage = { type: 'change', key, value };
        for (const cb of this.subscribers) {
          cb(message);
        }
      }
    } catch (error) {
      console.error('[SettingsBroadcastService] Failed to handle change:', error);
    }
  }

  private async cleanupListenerClient(): Promise<void> {
    if (!this.listenerClient) return;
    const client = this.listenerClient;
    this.listenerClient = null;
    client.removeAllListeners();
    try {
      await client.query('UNLISTEN *');
      client.release();
    } catch {
      // UNLISTEN failed (connection broken) — release with error flag so the
      // pool discards this connection rather than returning it for reuse.
      try { client.release(true); } catch { /* best-effort */ }
    }
  }

  private stopListening(): void {
    this.stopped = true;
    this.reconnecting = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    void this.cleanupListenerClient();
  }

  async stop(): Promise<void> {
    this.stopListening();
    this.subscribers.clear();
  }
}

export const settingsBroadcastService = new SettingsBroadcastService();

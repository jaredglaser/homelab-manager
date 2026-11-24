import type { PoolClient } from 'pg';
import type { SettingsWireMessage } from '@/types/settings';
import { backoffDelayMs } from '@/lib/utils/backoff';
import { USER_SETTINGS_CHANNEL, parseUserSettingsNotifyPayload } from '@/lib/database/repositories/settings-repository';

type SettingsCallback = (message: SettingsWireMessage) => void;

const GLOBAL_SETTINGS_CHANNEL = 'settings_change';

async function getDatabasePool() {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const client = await databaseConnectionManager.getClient(loadDatabaseConfig());
  return client.getPool();
}

async function defaultGetPoolClient(): Promise<PoolClient> {
  return await (await getDatabasePool()).connect();
}

async function defaultLoadAllSettings(): Promise<Map<string, string>> {
  const { SettingsRepository } = await import('@/lib/database/repositories/settings-repository');
  return await new SettingsRepository(await getDatabasePool()).getAll();
}

async function defaultLoadSingleSetting(key: string): Promise<string | null> {
  const { SettingsRepository } = await import('@/lib/database/repositories/settings-repository');
  return await new SettingsRepository(await getDatabasePool()).get(key);
}

export interface SettingsBroadcastServiceDeps<Scope = void> {
  getPoolClient?: () => Promise<PoolClient>;
  channel?: string;
  /** Maps a NOTIFY payload to the scope whose subscribers receive the change. A null result drops it. */
  parseNotification?: (payload: string) => { scope: Scope; key: string } | null;
  loadAllSettings?: (scope: Scope) => Promise<Map<string, string>>;
  loadSingleSetting?: (key: string, scope: Scope) => Promise<string | null>;
}

/**
 * Server-side broadcast service for settings changes.
 *
 * Listens to PostgreSQL NOTIFY on one channel and broadcasts changes to the
 * subscribers of the scope the notification names. On subscribe, sends that
 * scope's full settings state as an 'init' message - this handles both
 * startup sync and reconnection recovery.
 *
 * Auto-starts on first subscriber, auto-stops on last unsubscribe.
 */
export class SettingsBroadcastService<Scope = void> {
  private subscribers = new Map<SettingsCallback, Scope>();
  private listenerClient: PoolClient | null = null;
  private stopped = true;
  private listenGeneration = 0;
  private reconnecting = false;
  private reconnectFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * In-flight startListening() promise. Serializes concurrent callers
   * (e.g., a subscribe() and a reconnect timer firing simultaneously)
   * so we never end up with two pending pool.connect() calls leaking
   * a listenerClient.
   */
  private startInFlight: Promise<boolean> | null = null;
  private readonly getPoolClient: () => Promise<PoolClient>;
  private readonly channel: string;
  private readonly parseNotification: (payload: string) => { scope: Scope; key: string } | null;
  private readonly loadAllSettings: (scope: Scope) => Promise<Map<string, string>>;
  private readonly loadSingleSetting: (key: string, scope: Scope) => Promise<string | null>;

  constructor(deps: SettingsBroadcastServiceDeps<Scope> = {}) {
    this.getPoolClient = deps.getPoolClient ?? defaultGetPoolClient;
    this.channel = deps.channel ?? GLOBAL_SETTINGS_CHANNEL;
    this.parseNotification = deps.parseNotification ?? ((key) => ({ scope: undefined as Scope, key }));
    this.loadAllSettings = deps.loadAllSettings ?? defaultLoadAllSettings;
    this.loadSingleSetting = deps.loadSingleSetting ?? defaultLoadSingleSetting;
  }

  subscribe(callback: SettingsCallback, scope: Scope): () => void {
    this.subscribers.set(callback, scope);

    if (this.subscribers.size === 1) {
      void this.startListening();
    }

    // Send full state to new subscriber
    void this.sendInit(callback, scope);

    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.stopListening();
      }
    };
  }

  private async sendInit(callback: SettingsCallback, scope: Scope): Promise<void> {
    try {
      const all = await this.loadAllSettings(scope);

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
    const inFlight = this.doStartListening().finally(() => {
      if (this.startInFlight === inFlight) this.startInFlight = null;
    });
    this.startInFlight = inFlight;
    return inFlight;
  }

  private async doStartListening(): Promise<boolean> {
    this.stopped = false;
    const generation = this.listenGeneration;
    let poolClient: PoolClient | null = null;

    try {
      poolClient = await this.getPoolClient();

      if (this.stopped || generation !== this.listenGeneration) {
        try { poolClient.release(); } catch { /* best-effort */ }
        return false;
      }

      this.listenerClient = poolClient;

      this.listenerClient.on('notification', (msg) => {
        if (msg.channel === this.channel && msg.payload) {
          void this.handleChange(msg.payload);
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

      await this.listenerClient.query(`LISTEN ${this.channel}`);
      this.reconnectFailures = 0;
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
      if (!this.stopped && generation === this.listenGeneration && this.subscribers.size > 0 && !this.reconnecting) {
        this.reconnecting = true;
        this.scheduleReconnect();
      }
      return false;
    }
  }

  /** Re-send full settings state to every active subscriber. */
  private async resyncAllSubscribers(): Promise<void> {
    for (const scope of new Set(this.subscribers.values())) {
      try {
        const all = await this.loadAllSettings(scope);
        const message: SettingsWireMessage = { type: 'init', settings: Object.fromEntries(all) };
        this.deliver(scope, message, 'resync');
      } catch (error) {
        console.error('[SettingsBroadcastService] Failed to resync subscribers:', error);
      }
    }
  }

  private hasSubscriberFor(scope: Scope): boolean {
    for (const subscribedScope of this.subscribers.values()) {
      if (subscribedScope === scope) return true;
    }
    return false;
  }

  private deliver(scope: Scope, message: SettingsWireMessage, phase: 'change' | 'resync'): void {
    for (const [cb, subscribedScope] of this.subscribers) {
      if (subscribedScope !== scope) continue;
      try {
        cb(message);
      } catch (err) {
        console.error(`[SettingsBroadcastService] Subscriber callback failed during ${phase}:`, err);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delayMs = backoffDelayMs(this.reconnectFailures, { baseMs: 500, capMs: 30_000 });
    this.reconnectFailures++;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.stopped && this.subscribers.size > 0) {
        const ok = await this.startListening();
        if (ok) {
          this.reconnecting = false;
          // Settings may have changed during the disconnect window; push the
          // current state to all subscribers so their cached view is fresh.
          await this.resyncAllSubscribers();
        } else {
          // Still reconnecting: retry again after the next backoff step.
          // Note: startListening() may have already scheduled a retry via its
          // own catch block; scheduleReconnect() is idempotent thanks to the
          // reconnectTimer guard, so calling it again is safe.
          this.scheduleReconnect();
        }
      } else {
        this.reconnecting = false;
      }
    }, delayMs);
  }

  private async handleChange(payload: string): Promise<void> {
    const target = this.parseNotification(payload);
    if (target === null || !this.hasSubscriberFor(target.scope)) return;
    try {
      const value = await this.loadSingleSetting(target.key, target.scope);

      if (value !== null) {
        this.deliver(target.scope, { type: 'change', key: target.key, value }, 'change');
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
      // UNLISTEN failed (connection broken): release with error flag so the
      // pool discards this connection rather than returning it for reuse.
      try { client.release(true); } catch { /* best-effort */ }
    }
  }

  private stopListening(): void {
    this.stopped = true;
    this.listenGeneration++;
    this.startInFlight = null;
    this.reconnecting = false;
    this.reconnectFailures = 0;
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

/** Scoped by user id, which the caller takes from the authenticated session. */
export const userSettingsBroadcastService = new SettingsBroadcastService<number>({
  channel: USER_SETTINGS_CHANNEL,
  parseNotification: parseUserSettingsNotifyPayload,
  loadAllSettings: async (userId) => {
    const { UserSettingsRepository } = await import('@/lib/database/repositories/settings-repository');
    return await new UserSettingsRepository(await getDatabasePool()).getAll(userId);
  },
  loadSingleSetting: async (key, userId) => {
    const { UserSettingsRepository } = await import('@/lib/database/repositories/settings-repository');
    return await new UserSettingsRepository(await getDatabasePool()).get(userId, key);
  },
});

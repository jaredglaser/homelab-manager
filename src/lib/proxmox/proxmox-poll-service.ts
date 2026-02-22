import type { ProxmoxClusterOverview } from '@/types/proxmox';
import type { PoolClient } from 'pg';

type ProxmoxCallback = (overview: ProxmoxClusterOverview) => void;

const DEFAULT_POLL_INTERVAL_MS = 10_000; // Default to 10 seconds

async function getUpdateInterval(): Promise<number> {
  try {
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { SettingsRepository } = await import('@/lib/database/repositories/settings-repository');

    const config = loadDatabaseConfig();
    const client = await databaseConnectionManager.getClient(config);
    const repo = new SettingsRepository(client.getPool());

    const interval = await repo.get('proxmox/updateInterval');
    const parsed = interval ? parseInt(interval, 10) : DEFAULT_POLL_INTERVAL_MS;

    // Validate it's a valid interval (1s or 10s)
    return parsed === 1000 || parsed === 10000 ? parsed : DEFAULT_POLL_INTERVAL_MS;
  } catch {
    return DEFAULT_POLL_INTERVAL_MS;
  }
}

/**
 * Shared poll service for Proxmox cluster overview.
 *
 * Reads the update interval from database settings and polls at that rate.
 * Broadcasts the result to all subscribed SSE clients. This prevents
 * duplicate API requests when multiple browser tabs are open.
 *
 * Listens for settings changes and dynamically updates the poll interval.
 *
 * Auto-starts polling when the first subscriber joins,
 * auto-stops when the last subscriber leaves.
 */
class ProxmoxPollService {
  private subscribers = new Set<ProxmoxCallback>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastOverview: ProxmoxClusterOverview | null = null;
  private listenerClient: PoolClient | null = null;

  subscribe(callback: ProxmoxCallback): () => void {
    this.subscribers.add(callback);

    const isFirstSubscriber = this.subscribers.size === 1;

    // Send cached overview immediately, but only if we're not about to poll
    // (first subscriber triggers immediate poll in startPolling)
    if (this.lastOverview && !isFirstSubscriber) {
      callback(this.lastOverview);
    }

    if (isFirstSubscriber) {
      this.startPolling();
    }

    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.stopPolling();
      }
    };
  }

  private async startPolling(): Promise<void> {
    // Fetch immediately, then on interval
    this.poll();

    const interval = await getUpdateInterval();
    this.intervalId = setInterval(() => {
      this.poll();
    }, interval);

    // Listen for settings changes to dynamically update interval
    await this.setupSettingsListener();
  }

  private async setupSettingsListener(): Promise<void> {
    try {
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');

      const config = loadDatabaseConfig();
      const client = await databaseConnectionManager.getClient(config);
      const pool = client.getPool();

      this.listenerClient = await pool.connect();

      this.listenerClient.on('notification', (msg) => {
        if (msg.channel === 'settings_change' && msg.payload === 'proxmox/updateInterval') {
          // Restart polling with new interval
          this.restartPolling();
        }
      });

      await this.listenerClient.query('LISTEN settings_change');
    } catch (error) {
      console.error('[ProxmoxPollService] Failed to setup settings listener:', error);
    }
  }

  private async restartPolling(): Promise<void> {
    // Stop current polling
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Start with new interval
    const interval = await getUpdateInterval();
    this.intervalId = setInterval(() => {
      this.poll();
    }, interval);
  }

  private async poll(): Promise<void> {
    if (this.subscribers.size === 0) return;

    try {
      const { isProxmoxConfigured, loadProxmoxConfig } = await import(
        '@/lib/config/proxmox-config'
      );

      if (!isProxmoxConfigured()) return;

      const { proxmoxConnectionManager } = await import(
        '@/lib/clients/proxmox-client'
      );

      const config = loadProxmoxConfig();
      const client = proxmoxConnectionManager.getClient(config);
      const overview = await client.getClusterOverview();

      this.lastOverview = overview;

      for (const cb of this.subscribers) {
        cb(overview);
      }
    } catch (error) {
      // API call failed — skip this cycle, clients keep last data
      console.error('[ProxmoxPollService] Poll failed:', error);
    }
  }

  private stopPolling(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.listenerClient) {
      this.listenerClient.removeAllListeners();
      this.listenerClient.release();
      this.listenerClient = null;
    }
    this.lastOverview = null;
  }

  async stop(): Promise<void> {
    this.stopPolling();
    this.subscribers.clear();
  }
}

export const proxmoxPollService = new ProxmoxPollService();

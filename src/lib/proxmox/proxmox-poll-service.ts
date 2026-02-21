import type { ProxmoxClusterOverview } from '@/types/proxmox';

type ProxmoxCallback = (overview: ProxmoxClusterOverview) => void;

const POLL_INTERVAL_MS = 10_000;

/**
 * Shared poll service for Proxmox cluster overview.
 *
 * Runs a single setInterval that fetches from the Proxmox API and
 * broadcasts the result to all subscribed SSE clients. This prevents
 * duplicate API requests when multiple browser tabs are open.
 *
 * Auto-starts polling when the first subscriber joins,
 * auto-stops when the last subscriber leaves.
 */
class ProxmoxPollService {
  private subscribers = new Set<ProxmoxCallback>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastOverview: ProxmoxClusterOverview | null = null;

  subscribe(callback: ProxmoxCallback): () => void {
    this.subscribers.add(callback);

    // Send cached overview immediately so new clients don't wait for next poll
    if (this.lastOverview) {
      callback(this.lastOverview);
    }

    if (this.subscribers.size === 1) {
      this.startPolling();
    }

    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.stopPolling();
      }
    };
  }

  private startPolling(): void {
    // Fetch immediately, then on interval
    this.poll();

    this.intervalId = setInterval(() => {
      this.poll();
    }, POLL_INTERVAL_MS);
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
    } catch {
      // API call failed — skip this cycle, clients keep last data
    }
  }

  private stopPolling(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.lastOverview = null;
  }

  async stop(): Promise<void> {
    this.stopPolling();
    this.subscribers.clear();
  }
}

export const proxmoxPollService = new ProxmoxPollService();

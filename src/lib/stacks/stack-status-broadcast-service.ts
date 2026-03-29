import type { PoolClient } from 'pg';
import type { StackStatusRow } from '@/lib/database/repositories/stack-status-repository';

type StackStatusCallback = (entries: StackStatusRow[]) => void;

/**
 * Server-side broadcast service for stack status changes.
 *
 * Listens to PostgreSQL NOTIFY on the 'stack_change' channel and
 * broadcasts changes to all subscribed SSE clients. On subscribe,
 * sends the full stack_status table as an init payload — this handles
 * both startup sync and reconnection recovery.
 *
 * Auto-starts on first subscriber, auto-stops on last unsubscribe.
 */
class StackStatusBroadcastService {
  private subscribers = new Set<StackStatusCallback>();
  private listenerClient: PoolClient | null = null;
  private stopped = true;
  private reconnecting = false;

  subscribe(callback: StackStatusCallback): () => void {
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

  private async sendInit(callback: StackStatusCallback): Promise<void> {
    try {
      const all = await this.loadAllStackStatus();
      if (this.subscribers.has(callback)) {
        callback(all);
      }
    } catch (error) {
      console.error('[StackStatusBroadcastService] Failed to send init:', error);
    }
  }

  private async startListening(): Promise<void> {
    this.stopped = false;

    while (!this.stopped) {
      try {
        const { loadDatabaseConfig } = await import('@/lib/config/database-config');
        const { databaseConnectionManager } = await import('@/lib/clients/database-client');

        const config = loadDatabaseConfig();
        const client = await databaseConnectionManager.getClient(config);
        const pool = client.getPool();
        const poolClient = await pool.connect();

        if (this.stopped) {
          try { poolClient.release(); } catch { /* best-effort */ }
          return;
        }

        this.listenerClient = poolClient;

        this.listenerClient.on('notification', (msg) => {
          if (msg.channel === 'stack_change') {
            this.broadcastAll(msg.payload);
          }
        });

        this.listenerClient.on('error', (err) => {
          console.error('[StackStatusBroadcastService] Listener client error:', err);
          this.cleanupListenerClient();
          if (!this.stopped && this.subscribers.size > 0 && !this.reconnecting) {
            this.reconnecting = true;
            setTimeout(() => {
              this.reconnecting = false;
              if (!this.stopped && this.subscribers.size > 0) {
                this.startListening();
              }
            }, 5_000);
          }
        });

        await this.listenerClient.query('LISTEN stack_change');
        return;
      } catch (error) {
        console.error('[StackStatusBroadcastService] Failed to start listener, retrying in 5s:', error);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  }

  private async loadAllStackStatus(): Promise<StackStatusRow[]> {
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { StackStatusRepository } = await import(
      '@/lib/database/repositories/stack-status-repository'
    );

    const config = loadDatabaseConfig();
    const client = await databaseConnectionManager.getClient(config);
    const repo = new StackStatusRepository(client.getPool());
    return repo.getAll();
  }

  private async broadcastAll(payload?: string): Promise<void> {
    try {
      let entries: StackStatusRow[];

      if (payload) {
        try {
          const row = JSON.parse(payload);
          entries = [{
            stack: row.stack,
            host: row.host,
            containers: row.containers,
            updated_at: new Date(row.updated_at),
          }];
        } catch {
          entries = await this.loadAllStackStatus();
        }
      } else {
        entries = await this.loadAllStackStatus();
      }

      for (const cb of this.subscribers) {
        cb(entries);
      }
    } catch (error) {
      console.error('[StackStatusBroadcastService] Failed to broadcast:', error);
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
    this.cleanupListenerClient();
  }

  async stop(): Promise<void> {
    this.stopListening();
    this.subscribers.clear();
  }
}

export const stackStatusBroadcastService = new StackStatusBroadcastService();

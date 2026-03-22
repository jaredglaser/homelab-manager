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
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');
      const { StackStatusRepository } = await import(
        '@/lib/database/repositories/stack-status-repository'
      );

      const config = loadDatabaseConfig();
      const client = await databaseConnectionManager.getClient(config);
      const repo = new StackStatusRepository(client.getPool());
      const all = await repo.getAll();

      // Only send if subscriber is still active
      if (this.subscribers.has(callback)) {
        callback(all);
      }
    } catch (error) {
      console.error('[StackStatusBroadcastService] Failed to send init:', error);
    }
  }

  private async startListening(): Promise<void> {
    this.stopped = false;

    try {
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');

      const config = loadDatabaseConfig();
      const client = await databaseConnectionManager.getClient(config);
      const pool = client.getPool();
      const poolClient = await pool.connect();

      if (this.stopped) {
        poolClient.release();
        return;
      }

      this.listenerClient = poolClient;

      this.listenerClient.on('notification', (msg) => {
        if (msg.channel === 'stack_change') {
          this.broadcastAll();
        }
      });

      this.listenerClient.on('error', (err) => {
        console.error('[StackStatusBroadcastService] Listener connection error:', err.message);
        this.stopListening();
        // Restart if there are still subscribers
        if (this.subscribers.size > 0) {
          this.startListening();
        }
      });

      await this.listenerClient.query('LISTEN stack_change');
    } catch (error) {
      console.error('[StackStatusBroadcastService] Failed to start listener:', error);
    }
  }

  private async broadcastAll(): Promise<void> {
    try {
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');
      const { StackStatusRepository } = await import(
        '@/lib/database/repositories/stack-status-repository'
      );

      const config = loadDatabaseConfig();
      const client = await databaseConnectionManager.getClient(config);
      const repo = new StackStatusRepository(client.getPool());
      const all = await repo.getAll();

      for (const cb of this.subscribers) {
        cb(all);
      }
    } catch (error) {
      console.error('[StackStatusBroadcastService] Failed to broadcast:', error);
    }
  }

  private stopListening(): void {
    this.stopped = true;
    if (this.listenerClient) {
      this.listenerClient.removeAllListeners();
      this.listenerClient.release();
      this.listenerClient = null;
    }
  }

  async stop(): Promise<void> {
    this.stopListening();
    this.subscribers.clear();
  }
}

export const stackStatusBroadcastService = new StackStatusBroadcastService();

import type { PoolClient } from 'pg';
import type { StackStatusRow } from '@/lib/database/repositories/stack-status-repository';

/** Discriminated union for events sent to SSE subscribers. */
export type StackBroadcastEvent =
  | { type: 'status'; entries: StackStatusRow[] }
  | { type: 'deploy_changed'; stack: string; host: string };

type StackBroadcastCallback = (event: StackBroadcastEvent) => void;

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
  private subscribers = new Set<StackBroadcastCallback>();
  private listenerClient: PoolClient | null = null;
  private stopped = true;
  private reconnecting = false;

  subscribe(callback: StackBroadcastCallback): () => void {
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

  private async sendInit(callback: StackBroadcastCallback): Promise<void> {
    try {
      const all = await this.loadAllStackStatus();
      if (this.subscribers.has(callback)) {
        callback({ type: 'status', entries: all });
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
      if (payload) {
        try {
          const parsed = JSON.parse(payload);

          if (parsed.type === 'deploy_changed') {
            if (!parsed.stack || !parsed.host) throw new Error('Invalid deploy_changed payload');
            for (const cb of this.subscribers) {
              try {
                cb({ type: 'deploy_changed', stack: parsed.stack, host: parsed.host });
              } catch (err) {
                console.error('[StackStatusBroadcastService] Subscriber callback failed:', err);
              }
            }
            return;
          }

          if (Array.isArray(parsed) || !parsed.stack || !parsed.host || !parsed.containers || !parsed.updated_at) {
            throw new Error('Invalid status payload shape');
          }
          const updatedAt = new Date(parsed.updated_at);
          if (isNaN(updatedAt.getTime())) throw new Error('Invalid updated_at date');

          const entries: StackStatusRow[] = [{
            stack: parsed.stack,
            host: parsed.host,
            containers: parsed.containers,
            updated_at: updatedAt,
          }];
          for (const cb of this.subscribers) {
            try {
              cb({ type: 'status', entries });
            } catch (err) {
              console.error('[StackStatusBroadcastService] Subscriber callback failed:', err);
            }
          }
          return;
        } catch {
          // Non-JSON payload — fall through to full reload
        }
      }

      const entries = await this.loadAllStackStatus();
      for (const cb of this.subscribers) {
        try {
          cb({ type: 'status', entries });
        } catch (err) {
          console.error('[StackStatusBroadcastService] Subscriber callback failed:', err);
        }
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

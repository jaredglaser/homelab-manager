import { Client, type ClientConfig } from 'pg';
import { EventEmitter } from 'events';
import { loadDatabaseConfig } from '@/lib/config/database-config';

/**
 * Minimal NOTIFY/LISTEN service.
 * Maintains a dedicated PostgreSQL connection that listens for notifications
 * and re-emits them as EventEmitter events.
 */
class NotifyService extends EventEmitter {
  private client: Client | null = null;
  private isRunning = false;
  private startPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly baseReconnectDelay = 1000;

  /**
   * Start the notify service. Safe to call multiple times (idempotent).
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    await this.connect();
    this.isRunning = true;
    this.reconnectAttempts = 0;
  }

  private async connect(): Promise<void> {
    const config = loadDatabaseConfig();

    const clientConfig: ClientConfig = {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
    };

    if (config.ssl) {
      clientConfig.ssl = { rejectUnauthorized: false };
    }

    this.client = new Client(clientConfig);

    this.client.on('error', (err) => {
      console.error('[NotifyService] Client error:', err);
      this.scheduleReconnect();
    });

    this.client.on('end', () => {
      if (this.isRunning) {
        this.scheduleReconnect();
      }
    });

    this.client.on('notification', (msg) => {
      this.emit(msg.channel, msg.payload);
    });

    await this.client.connect();
    await this.client.query('LISTEN stats_update');
    await this.client.query('LISTEN settings_change');
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[NotifyService] Max reconnect attempts reached');
      this.isRunning = false;
      return;
    }

    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      30000
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      try {
        if (this.client) {
          try { await this.client.end(); } catch { /* ignore */ }
          this.client = null;
        }
        await this.connect();
        this.reconnectAttempts = 0;
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try { await this.client.end(); } catch { /* ignore */ }
      this.client = null;
    }
  }
}

export const notifyService = new NotifyService();

// Server-only marker: any import of this file from the client graph fails the
// build instead of breaking at runtime with node:async_hooks errors.
import '@tanstack/react-start/server-only';
import { Pool, type PoolConfig } from 'pg';
import type { StreamingClient } from '../streaming/types';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  max?: number;
  ssl?: boolean;
  /**
   * Whether to verify the server's TLS certificate when `ssl` is true.
   * Defaults to `true` (secure) when unset. Set to `false` only for
   * self-signed cert setups where proper CA plumbing isn't yet available.
   * Doing so exposes the connection to MITM attacks.
   */
  sslRejectUnauthorized: boolean;
}

/**
 * Database client wrapper implementing StreamingClient interface
 * Provides connection pooling via pg.Pool
 */
export class DatabaseClient implements StreamingClient {
  readonly id: string;
  private pool: Pool;
  private connected: boolean = false;

  constructor(config: DatabaseConfig) {
    this.id = `postgres://${config.user}@${config.host}:${config.port}/${config.database}`;

    const poolConfig: PoolConfig = {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.max || 10,
      connectionTimeoutMillis: 5000,
    };

    if (config.ssl) {
      poolConfig.ssl = { rejectUnauthorized: config.sslRejectUnauthorized };
    }

    this.pool = new Pool(poolConfig);

    // Mark as disconnected when idle pool connections are lost (e.g. DB container stops).
    // Without this handler pg emits an unhandled error; with it, the next getClient()
    // call sees isConnected()=false and creates a fresh connection.
    this.pool.on('error', (err) => {
      console.error('[DatabaseClient] Pool error on idle client:', err.message);
      this.connected = false;
    });
  }

  /**
   * Test connection to PostgreSQL
   */
  async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      this.connected = true;
    } catch (err) {
      this.connected = false;
      console.error(`[DatabaseClient] Connection failed:`, err);
      throw err;
    }
  }

  /**
   * Get the underlying Pool instance
   */
  getPool(): Pool {
    if (!this.connected) {
      throw new Error('Database client not connected');
    }
    return this.pool;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    await this.pool.end();
    this.connected = false;
  }
}

/**
 * Database connection manager singleton
 * Manages connection pooling and lifecycle
 */
class DatabaseConnectionManager {
  private connections = new Map<string, DatabaseClient>();

  /**
   * Get or create a database client for the given config
   * Reuses existing connections when possible
   */
  async getClient(config: DatabaseConfig): Promise<DatabaseClient> {
    const key = `${config.host}:${config.port}/${config.database}`;

    let client = this.connections.get(key);

    if (!client || !client.isConnected()) {
      // Drop the stale pool before replacing it. Without this, every DB
      // restart cycle (pool 'error' flips isConnected to false) orphans a
      // Pool that still holds sockets, an error listener, and a connection
      // timer for the life of the process.
      if (client) {
        this.connections.delete(key);
        await client.close().catch(() => {});
      }
      const fresh = new DatabaseClient(config);
      try {
        await fresh.connect();
      } catch (err) {
        // connect() failed (DB still down): end the just-built pool so a
        // failing 1s poll tick doesn't leak a Pool on every retry.
        await fresh.close().catch(() => {});
        throw err;
      }
      this.connections.set(key, fresh);
      client = fresh;
    }

    return client;
  }

  /**
   * Close a specific connection
   */
  async closeConnection(id: string): Promise<void> {
    const client = this.connections.get(id);
    if (client) {
      await client.close();
      this.connections.delete(id);
    }
  }

  /**
   * Close all connections
   */
  async closeAll(): Promise<void> {
    const promises = Array.from(this.connections.values()).map(c => c.close());
    await Promise.all(promises);
    this.connections.clear();
  }
}

// Singleton instance
export const databaseConnectionManager = new DatabaseConnectionManager();

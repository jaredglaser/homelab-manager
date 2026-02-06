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
      max: config.max || 3,
      idleTimeoutMillis: 30000,
    };

    if (config.ssl) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }

    this.pool = new Pool(poolConfig);
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
      console.log(`[DatabaseClient] Connected to ${this.id}`);
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
    console.log(`[DatabaseClient] Closing connection: ${this.id}`);
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
      console.log(`[DatabaseConnectionManager] Creating new connection: ${key}`);
      client = new DatabaseClient(config);
      await client.connect();
      this.connections.set(key, client);
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
    console.log('[DatabaseConnectionManager] Closing all connections');
    const promises = Array.from(this.connections.values()).map(c => c.close());
    await Promise.all(promises);
    this.connections.clear();
  }
}

// Singleton instance
export const databaseConnectionManager = new DatabaseConnectionManager();

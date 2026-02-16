import { InfluxDB } from '@influxdata/influxdb-client';
import type { InfluxDBConfig } from '@/lib/config/influxdb-config';

/**
 * InfluxDB client wrapper providing access to the underlying InfluxDB instance.
 * Manages the connection lifecycle for time-series data operations.
 */
export class InfluxClient {
  readonly id: string;
  private client: InfluxDB;
  private _connected = false;

  constructor(private config: InfluxDBConfig) {
    this.id = `influxdb://${config.url}/${config.org}/${config.bucket}`;
    this.client = new InfluxDB({
      url: config.url,
      token: config.token,
    });
  }

  /**
   * Verify the connection to InfluxDB by executing a health check query.
   */
  async connect(): Promise<void> {
    try {
      // Simple query to verify connection — list buckets
      const queryApi = this.client.getQueryApi(this.config.org);
      await queryApi.collectRows('buckets()');
      this._connected = true;
      console.log(`[InfluxClient] Connected to ${this.id}`);
    } catch (err) {
      this._connected = false;
      console.error('[InfluxClient] Connection failed:', err);
      throw err;
    }
  }

  getClient(): InfluxDB {
    return this.client;
  }

  getOrg(): string {
    return this.config.org;
  }

  getBucket(): string {
    return this.config.bucket;
  }

  isConnected(): boolean {
    return this._connected;
  }

  async close(): Promise<void> {
    console.log(`[InfluxClient] Closing connection: ${this.id}`);
    this._connected = false;
  }
}

/**
 * InfluxDB connection manager singleton.
 * Manages client lifecycle and reuse.
 */
class InfluxConnectionManager {
  private connections = new Map<string, InfluxClient>();

  /**
   * Get or create an InfluxDB client for the given config.
   * Reuses existing connections when possible.
   */
  async getClient(config: InfluxDBConfig): Promise<InfluxClient> {
    const key = `${config.url}/${config.org}/${config.bucket}`;

    let client = this.connections.get(key);
    if (!client || !client.isConnected()) {
      console.log(`[InfluxConnectionManager] Creating new connection: ${key}`);
      client = new InfluxClient(config);
      await client.connect();
      this.connections.set(key, client);
    }

    return client;
  }

  async closeAll(): Promise<void> {
    console.log('[InfluxConnectionManager] Closing all connections');
    const promises = Array.from(this.connections.values()).map(c => c.close());
    await Promise.all(promises);
    this.connections.clear();
  }
}

/** Singleton instance */
export const influxConnectionManager = new InfluxConnectionManager();

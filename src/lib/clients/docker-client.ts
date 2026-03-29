import Dockerode from 'dockerode';
import type { StreamingClient } from '../streaming/types';

/**
 * Docker client wrapper implementing StreamingClient interface
 * Provides consistent interface with SSH client for connection management
 */
export class DockerClient implements StreamingClient {
  readonly id: string;
  private docker: Dockerode;
  private connected: boolean = false;
  private _debugLogging = false;

  constructor(config: { host: string; port: number; protocol?: 'ssh' | 'http' | 'https' }) {
    this.id = `docker://${config.host}:${config.port}`;
    this.docker = new Dockerode({
      protocol: config.protocol || 'http',
      host: config.host,
      port: config.port,
    });
  }

  set debugLogging(enabled: boolean) {
    this._debugLogging = enabled;
  }

  private debugLog(message: string): void {
    if (this._debugLogging) {
      console.log(message);
    }
  }

  /**
   * Test connection to Docker daemon
   */
  async connect(): Promise<void> {
    const t0 = performance.now();
    this.debugLog(`[DockerClient] Connecting to ${this.id}...`);
    try {
      // Test connection by pinging Docker daemon
      const pingResult = await this.docker.ping();
      const elapsed = (performance.now() - t0).toFixed(0);
      this.connected = true;
      this.debugLog(`[DockerClient] Connected to ${this.id} (ping=${elapsed}ms, response=${pingResult})`);
    } catch (err) {
      const elapsed = (performance.now() - t0).toFixed(0);
      this.connected = false;
      const errMsg = err instanceof Error ? err.message : String(err);
      const errCode = (err as any)?.code || 'unknown';
      console.error(
        `[DockerClient] Connection to ${this.id} failed after ${elapsed}ms:` +
        ` code=${errCode} message=${errMsg}`
      );
      throw err;
    }
  }

  /**
   * Get the underlying Dockerode instance
   * Maintains backward compatibility with existing code
   */
  getDocker(): Dockerode {
    if (!this.connected) {
      throw new Error('Docker client not connected');
    }
    return this.docker;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    this.debugLog(`[DockerClient] Closing connection: ${this.id} (was connected=${this.connected})`);
    // Dockerode doesn't need explicit cleanup
    // It uses HTTP connections which are handled by Node's http module
    this.connected = false;
  }
}

/**
 * Docker connection manager singleton
 * Manages connection pooling and lifecycle
 */
class DockerConnectionManager {
  private connections = new Map<string, DockerClient>();
  private _debugLogging = false;

  set debugLogging(enabled: boolean) {
    this._debugLogging = enabled;
    // Propagate to all existing clients
    for (const client of this.connections.values()) {
      client.debugLogging = enabled;
    }
  }

  private debugLog(message: string): void {
    if (this._debugLogging) {
      console.log(message);
    }
  }

  /**
   * Get or create a Docker client for the given config
   * Reuses existing connections when possible
   */
  async getClient(config: { host: string; port: number; protocol?: 'ssh' | 'http' | 'https' }): Promise<DockerClient> {
    const key = `${config.host}:${config.port}`;

    const existing = this.connections.get(key);

    if (existing && existing.isConnected()) {
      this.debugLog(`[DockerConnectionManager] Reusing existing connection: ${key}`);
      return existing;
    }

    if (existing) {
      this.debugLog(`[DockerConnectionManager] Existing connection ${key} is disconnected, creating new`);
    } else {
      this.debugLog(`[DockerConnectionManager] No existing connection for ${key}, creating new`);
    }

    const client = new DockerClient(config);
    client.debugLogging = this._debugLogging;
    await client.connect();
    this.connections.set(key, client);

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
    this.debugLog(`[DockerConnectionManager] Closing all connections (${this.connections.size} active)`);
    const promises = Array.from(this.connections.values()).map(client => client.close());
    await Promise.all(promises);
    this.connections.clear();
  }
}

// Singleton instance
export const dockerConnectionManager = new DockerConnectionManager();

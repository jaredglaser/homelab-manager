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

  constructor(config: { host: string; port: number; protocol?: 'ssh' | 'http' | 'https' }) {
    this.id = `docker://${config.host}:${config.port}`;
    this.docker = new Dockerode({
      protocol: config.protocol || 'http',
      host: config.host,
      port: config.port,
    });
  }

  /**
   * Test connection to Docker daemon
   */
  async connect(): Promise<void> {
    try {
      // Test connection by pinging Docker daemon
      await this.docker.ping();
      this.connected = true;
      console.log(`[DockerClient] Connected to ${this.id}`);
    } catch (err) {
      this.connected = false;
      console.error(`[DockerClient] Connection failed:`, err);
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
    console.log(`[DockerClient] Closing connection: ${this.id}`);
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

  /**
   * Get or create a Docker client for the given config
   * Reuses existing connections when possible
   */
  async getClient(config: { host: string; port: number; protocol?: 'ssh' | 'http' | 'https' }): Promise<DockerClient> {
    const key = `${config.host}:${config.port}`;

    let client = this.connections.get(key);

    if (!client || !client.isConnected()) {
      console.log(`[DockerConnectionManager] Creating new connection: ${key}`);
      client = new DockerClient(config);
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
    console.log('[DockerConnectionManager] Closing all connections');
    const promises = Array.from(this.connections.values()).map(client => client.close());
    await Promise.all(promises);
    this.connections.clear();
  }
}

// Singleton instance
export const dockerConnectionManager = new DockerConnectionManager();

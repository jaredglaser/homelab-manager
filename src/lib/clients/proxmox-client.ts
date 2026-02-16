import type { StreamingClient } from '@/lib/streaming/types';
import type { ProxmoxConfig } from '@/lib/config/proxmox-config';

/**
 * Proxmox API client wrapper.
 * Uses proxmox-api package with API token authentication.
 */
export class ProxmoxClient implements StreamingClient {
  readonly id: string;
  private proxmox: any; // proxmox-api returns a Proxy-based object
  private connected: boolean = false;
  private readonly config: ProxmoxConfig;

  constructor(config: ProxmoxConfig) {
    this.config = config;
    this.id = `proxmox://${config.host}:${config.port}`;
  }

  async connect(): Promise<void> {
    if (this.config.allowSelfSignedCerts) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    const proxmoxApi = (await import('proxmox-api')).default;
    this.proxmox = proxmoxApi({
      host: this.config.host,
      port: this.config.port,
      tokenID: this.config.tokenId,
      tokenSecret: this.config.tokenSecret,
    });

    // Verify connectivity by fetching cluster status
    await this.proxmox.version.$get();
    this.connected = true;
  }

  getApi(): any {
    if (!this.connected) throw new Error('Proxmox client not connected');
    return this.proxmox;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.proxmox = null;
  }
}

class ProxmoxConnectionManager {
  private connection: ProxmoxClient | null = null;

  async getClient(config: ProxmoxConfig): Promise<ProxmoxClient> {
    if (this.connection && this.connection.isConnected()) {
      return this.connection;
    }

    const client = new ProxmoxClient(config);
    await client.connect();
    this.connection = client;
    return client;
  }

  async closeAll(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }
  }
}

export const proxmoxConnectionManager = new ProxmoxConnectionManager();

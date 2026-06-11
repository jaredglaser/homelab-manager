import type { ProxmoxConfig } from '../config/proxmox-config';
import type {
  ProxmoxResponse,
  ProxmoxClusterStatus,
  ProxmoxResource,
  ProxmoxClusterSnapshot,
} from '../../types/proxmox';

// Covers both Bun's native fetch (`tls`) and Node.js-compat/undici fetch (`dispatcher`)
interface CrossRuntimeRequestInit extends RequestInit {
  tls?: { rejectUnauthorized?: boolean };
  dispatcher?: unknown;
}

/**
 * Proxmox VE API client using native fetch
 *
 * Handles API token authentication and self-signed certificates.
 * All methods return typed responses from the Proxmox REST API.
 */
export class ProxmoxClient {
  private baseUrl: string;
  private authHeader: string;
  private fetchOptions: CrossRuntimeRequestInit;
  private readonly dispatcherReady: Promise<void>;

  constructor(config: ProxmoxConfig) {
    this.baseUrl = `https://${config.host}:${config.port}/api2/json`;
    this.authHeader = `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`;
    this.fetchOptions = {};
    this.dispatcherReady = config.allowSelfSignedCerts
      ? this.initSelfSignedCerts()
      : Promise.resolve();
  }

  /**
   * Configure TLS bypass for self-signed certificates.
   * Sets Bun's `tls` option and asynchronously loads undici's `dispatcher` for Node.js/Vite SSR.
   */
  private initSelfSignedCerts(): Promise<void> {
    // `tls` is Bun's native fetch option (used in production)
    // `dispatcher` is the undici Agent option (used in Vite SSR dev mode via Node.js-compat fetch)
    // Both are set so the correct one is picked up by whichever fetch implementation is active
    this.fetchOptions.tls = { rejectUnauthorized: false };
    // Dynamic import keeps undici out of Vite's dependency scan.
    // Resolves at runtime in Node.js/Vite SSR; silently fails under Bun (which uses `tls` instead).
    return (import('undici' as string) as Promise<{ Agent: new (opts: Record<string, unknown>) => unknown }>)
      .then(({ Agent }) => {
        this.fetchOptions.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
      })
      .catch(() => {});
  }

  /**
   * Make an authenticated GET request to the Proxmox API
   */
  private async get<T>(path: string): Promise<T> {
    await this.dispatcherReady;
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...this.fetchOptions,
      headers: {
        Authorization: this.authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Proxmox API error: ${response.status} ${response.statusText} - ${text}`
      );
    }

    const json = (await response.json()) as ProxmoxResponse<T>;
    return json.data;
  }

  /**
   * Test connectivity to the Proxmox API
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.get<unknown>('/version');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get cluster status
   */
  async getClusterStatus(): Promise<ProxmoxClusterStatus[]> {
    return this.get<ProxmoxClusterStatus[]>('/cluster/status');
  }

  /**
   * Get all cluster resources (nodes, VMs, containers, storage) in one call
   */
  async getClusterResources(): Promise<ProxmoxResource[]> {
    return this.get<ProxmoxResource[]>('/cluster/resources');
  }

  /**
   * Fetch a full cluster snapshot with exactly 2 requests.
   *
   * /cluster/resources returns every node, guest, and storage entry in one
   * response, so the request count stays constant as nodes are added. The
   * previous per-node fan-out (qemu + lxc + storage per online node) cost
   * 2 + 3N requests per poll cycle.
   */
  async getClusterSnapshot(): Promise<ProxmoxClusterSnapshot> {
    const [clusterStatusEntries, resources] = await Promise.all([
      this.getClusterStatus(),
      this.getClusterResources(),
    ]);

    const clusterEntry = clusterStatusEntries.find((e) => e.type === 'cluster');

    return {
      clusterName: clusterEntry?.name || 'Standalone',
      quorate: clusterEntry?.quorate === 1,
      version: clusterEntry?.version || 0,
      resources,
    };
  }
}

/**
 * Proxmox connection manager singleton
 * Caches client instances by host
 */
export class ProxmoxConnectionManager {
  private clients = new Map<string, ProxmoxClient>();

  getClient(config: ProxmoxConfig): ProxmoxClient {
    const key = `${config.host}:${config.port}`;

    let client = this.clients.get(key);
    if (!client) {
      client = new ProxmoxClient(config);
      this.clients.set(key, client);
    }

    return client;
  }

  clearAll(): void {
    this.clients.clear();
  }
}

export const proxmoxConnectionManager = new ProxmoxConnectionManager();

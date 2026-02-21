import type { ProxmoxConfig } from '../config/proxmox-config';
import type {
  ProxmoxResponse,
  ProxmoxNode,
  ProxmoxClusterStatus,
  ProxmoxResource,
  ProxmoxVM,
  ProxmoxContainer,
  ProxmoxStorage,
  ProxmoxClusterOverview,
} from '../../types/proxmox';

/**
 * Proxmox VE API client using native fetch
 *
 * Handles API token authentication and self-signed certificates.
 * All methods return typed responses from the Proxmox REST API.
 */
export class ProxmoxClient {
  private baseUrl: string;
  private authHeader: string;
  private fetchOptions: RequestInit;

  constructor(config: ProxmoxConfig) {
    this.baseUrl = `https://${config.host}:${config.port}/api2/json`;
    this.authHeader = `PVEAPIToken=${config.tokenId}=${config.tokenSecret}`;
    this.fetchOptions = {};

    if (config.allowSelfSignedCerts) {
      // Bun supports tls options on fetch
      (this.fetchOptions as Record<string, unknown>).tls = {
        rejectUnauthorized: false,
      };
    }
  }

  /**
   * Make an authenticated GET request to the Proxmox API
   */
  private async get<T>(path: string): Promise<T> {
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
   * Get all cluster resources (nodes, VMs, containers, storage)
   */
  async getClusterResources(type?: string): Promise<ProxmoxResource[]> {
    const path = type ? `/cluster/resources?type=${type}` : '/cluster/resources';
    return this.get<ProxmoxResource[]>(path);
  }

  /**
   * Get all nodes
   */
  async getNodes(): Promise<ProxmoxNode[]> {
    return this.get<ProxmoxNode[]>('/nodes');
  }

  /**
   * Get VMs for a specific node
   */
  async getNodeVMs(node: string): Promise<ProxmoxVM[]> {
    return this.get<ProxmoxVM[]>(`/nodes/${encodeURIComponent(node)}/qemu`);
  }

  /**
   * Get containers for a specific node
   */
  async getNodeContainers(node: string): Promise<ProxmoxContainer[]> {
    return this.get<ProxmoxContainer[]>(`/nodes/${encodeURIComponent(node)}/lxc`);
  }

  /**
   * Get storage for a specific node
   */
  async getNodeStorage(node: string): Promise<ProxmoxStorage[]> {
    return this.get<ProxmoxStorage[]>(
      `/nodes/${encodeURIComponent(node)}/storage`
    );
  }

  /**
   * Fetch a complete cluster overview in parallel.
   * Gets nodes, then fetches VMs, containers, and storage for each node.
   */
  async getClusterOverview(): Promise<ProxmoxClusterOverview> {
    // Fetch cluster status and nodes in parallel
    const [clusterStatusEntries, nodes] = await Promise.all([
      this.getClusterStatus(),
      this.getNodes(),
    ]);

    // Extract cluster info
    const clusterEntry = clusterStatusEntries.find((e) => e.type === 'cluster');
    const clusterName = clusterEntry?.name || 'Standalone';
    const quorate = clusterEntry?.quorate === 1;
    const version = clusterEntry?.version || 0;

    // Fetch VMs, containers, and storage for all online nodes in parallel
    const onlineNodes = nodes.filter((n) => n.status === 'online');

    const perNodeResults = await Promise.all(
      onlineNodes.map(async (node) => {
        const [vms, containers, storages] = await Promise.all([
          this.getNodeVMs(node.node).catch(() => [] as ProxmoxVM[]),
          this.getNodeContainers(node.node).catch(() => [] as ProxmoxContainer[]),
          this.getNodeStorage(node.node).catch(() => [] as ProxmoxStorage[]),
        ]);
        return { node: node.node, vms, containers, storages };
      })
    );

    // Flatten results with node attribution
    const allVMs = perNodeResults.flatMap((r) =>
      r.vms
        .filter((vm) => !vm.template)
        .map((vm) => ({ ...vm, node: r.node }))
    );
    const allContainers = perNodeResults.flatMap((r) =>
      r.containers
        .filter((ct) => !ct.template)
        .map((ct) => ({ ...ct, node: r.node }))
    );
    const allStorages = perNodeResults.flatMap((r) =>
      r.storages.map((s) => ({ ...s, node: r.node }))
    );

    // Calculate totals
    const totalCpu = nodes.reduce((sum, n) => sum + n.maxcpu, 0);
    const usedCpu = nodes.reduce((sum, n) => sum + n.cpu * n.maxcpu, 0);
    const totalMemory = nodes.reduce((sum, n) => sum + n.maxmem, 0);
    const usedMemory = nodes.reduce((sum, n) => sum + n.mem, 0);
    const totalDisk = nodes.reduce((sum, n) => sum + n.maxdisk, 0);
    const usedDisk = nodes.reduce((sum, n) => sum + n.disk, 0);

    const runningVMs = allVMs.filter((vm) => vm.status === 'running').length;
    const stoppedVMs = allVMs.filter((vm) => vm.status !== 'running').length;
    const runningContainers = allContainers.filter(
      (ct) => ct.status === 'running'
    ).length;
    const stoppedContainers = allContainers.filter(
      (ct) => ct.status !== 'running'
    ).length;

    return {
      clusterName,
      quorate,
      version,
      nodes,
      vms: allVMs,
      containers: allContainers,
      storages: allStorages,
      totals: {
        totalCpu,
        usedCpu,
        totalMemory,
        usedMemory,
        totalDisk,
        usedDisk,
        runningVMs,
        stoppedVMs,
        runningContainers,
        stoppedContainers,
      },
    };
  }
}

/**
 * Proxmox connection manager singleton
 * Caches client instances by host
 */
class ProxmoxConnectionManager {
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

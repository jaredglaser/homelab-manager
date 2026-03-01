import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { ProxmoxClient, ProxmoxConnectionManager } from '../proxmox-client';
import type { ProxmoxConfig } from '@/lib/config/proxmox-config';

const originalConsoleError = console.error;

function createConfig(overrides?: Partial<ProxmoxConfig>): ProxmoxConfig {
  return {
    host: '192.168.1.100',
    port: 8006,
    tokenId: 'root@pam!test',
    tokenSecret: '12345678-1234-1234-1234-123456789012',
    allowSelfSignedCerts: true,
    ...overrides,
  };
}

describe('ProxmoxClient', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
    console.error = mock(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    console.error = originalConsoleError;
  });

  it('should construct with correct base URL', async () => {
    const client = new ProxmoxClient(createConfig());
    // Test via a request — the URL should contain the correct base
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: {} }), { status: 200 })
    );
    await client.testConnection();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callUrl = fetchSpy.mock.calls[0][0] as string;
    expect(callUrl).toContain('https://192.168.1.100:8006/api2/json');
  });

  it('should include authorization header', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: {} }), { status: 200 })
    );
    const client = new ProxmoxClient(createConfig());
    await client.testConnection();

    const callInit = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(callInit.headers).toEqual({
      Authorization: 'PVEAPIToken=root@pam!test=12345678-1234-1234-1234-123456789012',
    });
  });

  describe('testConnection', () => {
    it('should return true on success', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { version: '8.0' } }), { status: 200 })
      );
      const client = new ProxmoxClient(createConfig());
      const result = await client.testConnection();
      expect(result).toBe(true);
    });

    it('should return false on error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));
      const client = new ProxmoxClient(createConfig());
      const result = await client.testConnection();
      expect(result).toBe(false);
    });
  });

  describe('getClusterStatus', () => {
    it('should return cluster status entries', async () => {
      const mockData = [
        { type: 'cluster' as const, id: 'cluster', name: 'test', version: 5, quorate: 1, nodes: 2 },
        { type: 'node' as const, id: 'node/pve1', name: 'pve1', nodeid: 1, online: 1 },
      ];
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: mockData }), { status: 200 })
      );
      const client = new ProxmoxClient(createConfig());
      const result = await client.getClusterStatus();
      expect(result).toEqual(mockData);
    });
  });

  describe('getNodes', () => {
    it('should return nodes', async () => {
      const mockData = [
        { node: 'pve1', status: 'online', cpu: 0.25, maxcpu: 8, mem: 4e9, maxmem: 16e9, disk: 50e9, maxdisk: 500e9, uptime: 86400, type: 'node', id: 'node/pve1' },
      ];
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: mockData }), { status: 200 })
      );
      const client = new ProxmoxClient(createConfig());
      const result = await client.getNodes();
      expect(result).toHaveLength(1);
      expect(result[0].node).toBe('pve1');
    });
  });

  describe('getNodeVMs', () => {
    it('should fetch VMs for a node', async () => {
      const mockData = [{ vmid: 100, name: 'test-vm', status: 'running' }];
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: mockData }), { status: 200 })
      );
      const client = new ProxmoxClient(createConfig());
      const result = await client.getNodeVMs('pve1');
      expect(result).toHaveLength(1);
      expect(result[0].vmid).toBe(100);
    });
  });

  describe('getNodeContainers', () => {
    it('should fetch containers for a node', async () => {
      const mockData = [{ vmid: 200, name: 'test-ct', status: 'running', type: 'lxc' }];
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: mockData }), { status: 200 })
      );
      const client = new ProxmoxClient(createConfig());
      const result = await client.getNodeContainers('pve1');
      expect(result).toHaveLength(1);
      expect(result[0].vmid).toBe(200);
    });
  });

  describe('getNodeStorage', () => {
    it('should fetch storage for a node', async () => {
      const mockData = [{ storage: 'local', type: 'dir', content: 'rootdir', active: 1 }];
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: mockData }), { status: 200 })
      );
      const client = new ProxmoxClient(createConfig());
      const result = await client.getNodeStorage('pve1');
      expect(result).toHaveLength(1);
      expect(result[0].storage).toBe('local');
    });
  });

  describe('getClusterOverview', () => {
    it('should assemble cluster overview from multiple API calls', async () => {
      // Call 1: getClusterStatus
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { type: 'cluster', id: 'cluster', name: 'test-cluster', version: 3, quorate: 1, nodes: 1 },
          { type: 'node', id: 'node/pve1', name: 'pve1', nodeid: 1, online: 1 },
        ],
      }), { status: 200 }));

      // Call 2: getNodes
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          node: 'pve1', status: 'online', cpu: 0.5, maxcpu: 4,
          mem: 2e9, maxmem: 8e9, disk: 10e9, maxdisk: 100e9,
          uptime: 3600, type: 'node', id: 'node/pve1',
        }],
      }), { status: 200 }));

      // Call 3: getNodeVMs
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          vmid: 100, name: 'vm1', status: 'running', cpu: 0.1, cpus: 2,
          mem: 1e9, maxmem: 2e9, disk: 5e9, maxdisk: 20e9, uptime: 1000,
          netin: 100, netout: 50, diskread: 10, diskwrite: 5,
        }],
      }), { status: 200 }));

      // Call 4: getNodeContainers
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          vmid: 200, name: 'ct1', status: 'stopped', type: 'lxc', cpu: 0, cpus: 1,
          mem: 0, maxmem: 1e9, disk: 1e9, maxdisk: 5e9, uptime: 0,
          netin: 0, netout: 0, diskread: 0, diskwrite: 0, swap: 0, maxswap: 256e6,
        }],
      }), { status: 200 }));

      // Call 5: getNodeStorage
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          storage: 'local', type: 'dir', content: 'rootdir', active: 1,
          enabled: 1, shared: 0, used: 5e9, avail: 15e9, total: 20e9, used_fraction: 0.25,
        }],
      }), { status: 200 }));

      const client = new ProxmoxClient(createConfig());
      const overview = await client.getClusterOverview();

      expect(overview.clusterName).toBe('test-cluster');
      expect(overview.quorate).toBe(true);
      expect(overview.version).toBe(3);
      expect(overview.nodes).toHaveLength(1);
      expect(overview.vms).toHaveLength(1);
      expect(overview.containers).toHaveLength(1);
      expect(overview.storages).toHaveLength(1);
      expect(overview.totals.totalCpu).toBe(4);
      expect(overview.totals.usedCpu).toBe(2); // 0.5 * 4
      expect(overview.totals.runningVMs).toBe(1);
      expect(overview.totals.stoppedVMs).toBe(0);
      expect(overview.totals.stoppedContainers).toBe(1);
    });

    it('should filter out template VMs', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ type: 'cluster', id: 'cluster', name: 'c', version: 1, quorate: 1 }],
      }), { status: 200 }));

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          node: 'pve1', status: 'online', cpu: 0, maxcpu: 1,
          mem: 0, maxmem: 1e9, disk: 0, maxdisk: 1e9, uptime: 0, type: 'node', id: 'node/pve1',
        }],
      }), { status: 200 }));

      // VM with template=1 should be filtered
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          vmid: 900, name: 'template-vm', status: 'stopped', template: 1,
          cpu: 0, cpus: 1, mem: 0, maxmem: 1e9, disk: 0, maxdisk: 10e9,
          uptime: 0, netin: 0, netout: 0, diskread: 0, diskwrite: 0,
        }],
      }), { status: 200 }));

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const client = new ProxmoxClient(createConfig());
      const overview = await client.getClusterOverview();
      expect(overview.vms).toHaveLength(0);
    });

    it('should handle standalone cluster with no cluster entry', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ type: 'node', id: 'node/pve1', name: 'pve1' }],
      }), { status: 200 }));

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          node: 'pve1', status: 'online', cpu: 0, maxcpu: 1,
          mem: 0, maxmem: 1e9, disk: 0, maxdisk: 1e9, uptime: 0, type: 'node', id: 'node/pve1',
        }],
      }), { status: 200 }));

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const client = new ProxmoxClient(createConfig());
      const overview = await client.getClusterOverview();
      expect(overview.clusterName).toBe('Standalone');
      expect(overview.quorate).toBe(false);
    });

    it('should handle API error for per-node requests gracefully', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ type: 'cluster', id: 'cluster', name: 'c', version: 1, quorate: 1 }],
      }), { status: 200 }));

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          node: 'pve1', status: 'online', cpu: 0, maxcpu: 1,
          mem: 0, maxmem: 1e9, disk: 0, maxdisk: 1e9, uptime: 0, type: 'node', id: 'node/pve1',
        }],
      }), { status: 200 }));

      // VMs fail
      fetchSpy.mockRejectedValueOnce(new Error('Connection refused'));
      // Containers fail
      fetchSpy.mockRejectedValueOnce(new Error('Timeout'));
      // Storage fails
      fetchSpy.mockRejectedValueOnce(new Error('Not found'));

      const client = new ProxmoxClient(createConfig());
      const overview = await client.getClusterOverview();
      // Errors are caught per-node, so empty arrays
      expect(overview.vms).toHaveLength(0);
      expect(overview.containers).toHaveLength(0);
      expect(overview.storages).toHaveLength(0);
    });
  });

  describe('HTTP error handling', () => {
    it('should throw on non-OK response', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
      );
      const client = new ProxmoxClient(createConfig());
      await expect(client.getClusterStatus()).rejects.toThrow('Proxmox API error: 401');
    });
  });

  describe('self-signed cert options', () => {
    it('should not set TLS options when allowSelfSignedCerts is false', () => {
      const config = createConfig({ allowSelfSignedCerts: false });
      const client = new ProxmoxClient(config);

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: {} }), { status: 200 })
      );
      client.testConnection();

      const callInit = fetchSpy.mock.calls[0][1] as any;
      expect(callInit.tls).toBeUndefined();
    });
  });
});

describe('ProxmoxConnectionManager', () => {
  it('should cache clients by host:port', () => {
    const manager = new ProxmoxConnectionManager();
    const config = createConfig();

    const client1 = manager.getClient(config);
    const client2 = manager.getClient(config);
    expect(client1).toBe(client2);
  });

  it('should create different clients for different configs', () => {
    const manager = new ProxmoxConnectionManager();
    const client1 = manager.getClient(createConfig({ host: 'host1' }));
    const client2 = manager.getClient(createConfig({ host: 'host2' }));
    expect(client1).not.toBe(client2);
  });

  it('should clear all cached clients', () => {
    const manager = new ProxmoxConnectionManager();
    const client1 = manager.getClient(createConfig());
    manager.clearAll();
    const client2 = manager.getClient(createConfig());
    expect(client1).not.toBe(client2);
  });
});

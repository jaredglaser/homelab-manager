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
    // Test via a request - the URL should contain the correct base
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

  describe('getClusterResources', () => {
    it('should return all resource types from a single call', async () => {
      const mockData = [
        { id: 'node/pve1', type: 'node', node: 'pve1', status: 'online', cpu: 0.25, maxcpu: 8 },
        { id: 'qemu/100', type: 'qemu', node: 'pve1', status: 'running', vmid: 100, name: 'vm1' },
        { id: 'storage/pve1/local', type: 'storage', node: 'pve1', status: 'available', storage: 'local' },
      ];
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: mockData }), { status: 200 })
      );
      const client = new ProxmoxClient(createConfig());
      const result = await client.getClusterResources();
      expect(result).toHaveLength(3);
      expect(fetchSpy.mock.calls[0][0]).toContain('/cluster/resources');
    });
  });

  describe('getClusterSnapshot', () => {
    it('should assemble a snapshot from exactly 2 API calls', async () => {
      // Call 1: getClusterStatus
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { type: 'cluster', id: 'cluster', name: 'test-cluster', version: 3, quorate: 1, nodes: 1 },
          { type: 'node', id: 'node/pve1', name: 'pve1', nodeid: 1, online: 1 },
        ],
      }), { status: 200 }));

      // Call 2: getClusterResources
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          {
            id: 'node/pve1', type: 'node', node: 'pve1', status: 'online',
            cpu: 0.5, maxcpu: 4, mem: 2e9, maxmem: 8e9, disk: 10e9, maxdisk: 100e9, uptime: 3600,
          },
          {
            id: 'qemu/100', type: 'qemu', node: 'pve1', status: 'running', vmid: 100, name: 'vm1',
            cpu: 0.1, maxcpu: 2, mem: 1e9, maxmem: 2e9, disk: 5e9, maxdisk: 20e9,
            uptime: 1000, netin: 100, netout: 50,
          },
        ],
      }), { status: 200 }));

      const client = new ProxmoxClient(createConfig());
      const snapshot = await client.getClusterSnapshot();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const urls = fetchSpy.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(urls.some((u: string) => u.includes('/cluster/status'))).toBe(true);
      expect(urls.some((u: string) => u.includes('/cluster/resources'))).toBe(true);

      expect(snapshot.clusterName).toBe('test-cluster');
      expect(snapshot.quorate).toBe(true);
      expect(snapshot.version).toBe(3);
      expect(snapshot.resources).toHaveLength(2);
    });

    it('should handle standalone host with no cluster entry', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ type: 'node', id: 'node/pve1', name: 'pve1' }],
      }), { status: 200 }));

      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'node/pve1', type: 'node', node: 'pve1', status: 'online' }],
      }), { status: 200 }));

      const client = new ProxmoxClient(createConfig());
      const snapshot = await client.getClusterSnapshot();
      expect(snapshot.clusterName).toBe('Standalone');
      expect(snapshot.quorate).toBe(false);
      expect(snapshot.version).toBe(0);
    });

    it('should propagate API errors', async () => {
      fetchSpy.mockRejectedValue(new Error('Connection refused'));

      const client = new ProxmoxClient(createConfig());
      await expect(client.getClusterSnapshot()).rejects.toThrow('Connection refused');
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

    it('should handle response.text() failure gracefully in error', async () => {
      // Create a Response-like object whose text() throws
      const badResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.reject(new Error('stream consumed')),
      };
      fetchSpy.mockResolvedValueOnce(badResponse as unknown as Response);

      const client = new ProxmoxClient(createConfig());
      await expect(client.getClusterStatus()).rejects.toThrow('Proxmox API error: 500');
    });
  });

  describe('self-signed cert options', () => {
    it('should set TLS options when allowSelfSignedCerts is true', async () => {
      const config = createConfig({ allowSelfSignedCerts: true });
      const client = new ProxmoxClient(config);

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: {} }), { status: 200 })
      );
      await client.testConnection();

      const callInit = fetchSpy.mock.calls[0][1] as any;
      expect(callInit.tls).toEqual({ rejectUnauthorized: false });
    });

    it('should not set TLS options when allowSelfSignedCerts is false', async () => {
      const config = createConfig({ allowSelfSignedCerts: false });
      const client = new ProxmoxClient(config);

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: {} }), { status: 200 })
      );
      await client.testConnection();

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

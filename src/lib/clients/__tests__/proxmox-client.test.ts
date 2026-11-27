import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { ProxmoxClient, ProxmoxConnectionManager, ProxmoxRequestError } from '../proxmox-client';
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
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    await client.getClusterStatus();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callUrl = fetchSpy.mock.calls[0][0] as string;
    expect(callUrl).toContain('https://192.168.1.100:8006/api2/json');
  });

  it('should include authorization header', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    const client = new ProxmoxClient(createConfig());
    await client.getClusterStatus();

    const callInit = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(callInit.headers).toEqual({
      Authorization: 'PVEAPIToken=root@pam!test=12345678-1234-1234-1234-123456789012',
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
      expect(result).toEqual([
        { type: 'cluster', id: 'cluster', name: 'test', version: 5, quorate: 1, nodes: 2 },
        { type: 'node', id: 'node/pve1', name: 'pve1' },
      ]);
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

  describe('failure kinds', () => {
    async function failureOf(promise: Promise<unknown>): Promise<ProxmoxRequestError> {
      const err = await promise.then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ProxmoxRequestError);
      return err as ProxmoxRequestError;
    }

    it.each([401, 403])('sorts HTTP %d into token_rejected', async (status) => {
      fetchSpy.mockResolvedValueOnce(new Response('authentication failure', { status, statusText: 'No ticket' }));
      const failure = await failureOf(new ProxmoxClient(createConfig()).getClusterStatus());
      expect(failure.kind).toBe('token_rejected');
      expect(failure.code).toBe('token_rejected');
      expect(failure.message).toContain(`HTTP ${status}`);
    });

    it('sorts a 5xx, such as a node that lost quorum, into unreachable', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('cluster not ready - no quorum?', { status: 500, statusText: 'Internal Server Error' }));
      const failure = await failureOf(new ProxmoxClient(createConfig()).getClusterResources());
      expect(failure.kind).toBe('unreachable');
      expect(failure.message).toContain('/cluster/resources: HTTP 500');
      expect(failure.message).toContain('no quorum');
    });

    it('keeps the error when response.text() itself fails', async () => {
      const badResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.reject(new Error('stream consumed')),
      };
      fetchSpy.mockResolvedValueOnce(badResponse as unknown as Response);
      const failure = await failureOf(new ProxmoxClient(createConfig()).getClusterStatus());
      expect(failure.kind).toBe('unreachable');
      expect(failure.message).toContain('HTTP 500');
    });

    it('sorts a network error into unreachable', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Connection refused'));
      const failure = await failureOf(new ProxmoxClient(createConfig()).getClusterStatus());
      expect(failure.kind).toBe('unreachable');
      expect(failure.message).toBe('/cluster/status: Connection refused');
    });

    it('sorts a refused certificate into certificate_refused, read off the code or its cause', async () => {
      const direct = Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
      const wrapped = Object.assign(new Error('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
      fetchSpy.mockRejectedValueOnce(direct).mockRejectedValueOnce(wrapped);
      const client = new ProxmoxClient(createConfig({ allowSelfSignedCerts: false }));
      expect((await failureOf(client.getClusterStatus())).kind).toBe('certificate_refused');
      expect((await failureOf(client.getClusterStatus())).kind).toBe('certificate_refused');
    });

    it.each([
      ['data is null', JSON.stringify({ data: null })],
      ['data is missing', JSON.stringify({})],
      ['an entry has no id', JSON.stringify({ data: [{ type: 'qemu', vmid: 100 }] })],
      ['a counter is a string', JSON.stringify({ data: [{ id: 'qemu/100', type: 'qemu', netin: '12' }] })],
    ])('sorts a 200 whose %s into unreachable, naming the unexpected shape', async (_, body) => {
      fetchSpy.mockResolvedValueOnce(new Response(body, { status: 200 }));
      const failure = await failureOf(new ProxmoxClient(createConfig()).getClusterResources());
      expect(failure.kind).toBe('unreachable');
      expect(failure.message).toContain('/cluster/resources: unexpected response shape');
    });

    it('sorts a 200 that is not JSON into unreachable', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('<html>proxy login</html>', { status: 200 }));
      const failure = await failureOf(new ProxmoxClient(createConfig()).getClusterStatus());
      expect(failure.kind).toBe('unreachable');
      expect(failure.message).toContain('/cluster/status:');
    });

    it('fails the whole snapshot when either response is off shape', async () => {
      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: null }), { status: 200 }));
      const failure = await failureOf(new ProxmoxClient(createConfig()).getClusterSnapshot());
      expect(failure.kind).toBe('unreachable');
    });
  });

  describe('self-signed cert options', () => {
    it('should set TLS options when allowSelfSignedCerts is true', async () => {
      const config = createConfig({ allowSelfSignedCerts: true });
      const client = new ProxmoxClient(config);

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 })
      );
      await client.getClusterStatus();

      const callInit = fetchSpy.mock.calls[0][1] as any;
      expect(callInit.tls).toEqual({ rejectUnauthorized: false });
    });

    it('should not set TLS options when allowSelfSignedCerts is false', async () => {
      const config = createConfig({ allowSelfSignedCerts: false });
      const client = new ProxmoxClient(config);

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 })
      );
      await client.getClusterStatus();

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

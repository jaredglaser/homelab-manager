import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { ProxmoxClient, ProxmoxRequestError } from '../proxmox-client';
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
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

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
      ['data is an object', JSON.stringify({ data: { id: 'qemu/100' } })],
    ])('sorts a 200 whose %s into unreachable, naming the unexpected shape', async (_, body) => {
      fetchSpy.mockResolvedValueOnce(new Response(body, { status: 200 }));
      const failure = await failureOf(new ProxmoxClient(createConfig()).getClusterResources());
      expect(failure.kind).toBe('unreachable');
      expect(failure.message).toMatch(/^\/cluster\/resources: unexpected response shape: data invalid_type$/);
      expect(failure.detail).toBe('unexpected response shape: data invalid_type');
    });

    it('caps a long reason, such as a big error page', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('x'.repeat(100_000), { status: 502, statusText: 'Bad Gateway' }));
      const failure = await failureOf(new ProxmoxClient(createConfig()).getClusterStatus());
      expect(failure.detail.length).toBe(300);
      expect(failure.message.length).toBe(300);
      expect(failure.message.startsWith('/cluster/status: HTTP 502 Bad Gateway x')).toBe(true);
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

  describe('entries off the expected shape', () => {
    const good = (vmid: number) => ({ id: `qemu/${vmid}`, type: 'qemu', node: 'pve1', status: 'running', vmid, netin: 10 });

    it('drops only the bad entry, keeps the rest, and logs it', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [good(100), { type: 'qemu', vmid: 101 }, good(102)],
      }), { status: 200 }));
      const result = await new ProxmoxClient(createConfig()).getClusterResources();

      expect(result.map((r) => r.vmid)).toEqual([100, 102]);
      const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
      expect(logged).toEqual(['[ProxmoxClient] /cluster/resources: skipped 1 entry off the expected shape, first at data.1.id invalid_type']);
    });

    it.each([
      ['a node in /cluster/resources', '/cluster/resources', { id: 'node/pve1', type: 'node', node: 'pve1', maxcpu: 'many' }],
      ['the cluster entry in /cluster/status', '/cluster/status', { id: 'cluster', type: 'cluster', name: 'homelab', quorate: 'yes' }],
    ])('fails the poll as unreachable when %s is off shape, instead of dropping it', async (_, path, bad) => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [good(100), bad] }), { status: 200 }));
      const client = new ProxmoxClient(createConfig());
      const call = path === '/cluster/status' ? client.getClusterStatus() : client.getClusterResources();
      const failure = await call.then(() => null, (e: unknown) => e as ProxmoxRequestError);
      expect(failure).toBeInstanceOf(ProxmoxRequestError);
      expect(failure!.kind).toBe('unreachable');
      expect(failure!.message.startsWith(`${path}: unexpected response shape: data.1.`)).toBe(true);
    });

    it('reads a guest, node or storage name Proxmox sent as a number', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'qemu/100', type: 'qemu', vmid: 100, name: 1234, node: 7 }, { id: 'storage/7/9', type: 'storage', storage: 9 }],
      }), { status: 200 }));
      const entries = await new ProxmoxClient(createConfig()).getClusterResources();
      expect(entries[0]).toMatchObject({ name: '1234', node: '7' });
      expect(entries[1]).toMatchObject({ storage: '9' });
    });

    it('reads a number Proxmox sent as a string', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'qemu/100', type: 'qemu', vmid: '100', netin: '12', shared: '0' }],
      }), { status: 200 }));
      const [entry] = await new ProxmoxClient(createConfig()).getClusterResources();
      expect(entry).toMatchObject({ vmid: 100, netin: 12, shared: 0 });
    });

    it('drops an entry whose number field holds text that is not a number', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
        data: [good(100), { id: 'storage/pve1/local', type: 'storage', shared: 'yes' }],
      }), { status: 200 }));
      expect(await new ProxmoxClient(createConfig()).getClusterResources()).toHaveLength(1);
    });

    it('logs dropped entries at most once a minute per path', async () => {
      const nowSpy = spyOn(Date, 'now');
      let now = 1_000_000;
      nowSpy.mockImplementation(() => now);
      try {
        const client = new ProxmoxClient(createConfig());
        const body = () => new Response(JSON.stringify({ data: [{ id: 7 }] }), { status: 200 });
        fetchSpy.mockImplementation((() => Promise.resolve(body())) as unknown as typeof fetch);
        await client.getClusterResources();
        now += 30_000;
        await client.getClusterResources();
        await client.getClusterStatus();
        now += 31_000;
        await client.getClusterResources();
        expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(3);
      } finally {
        nowSpy.mockRestore();
      }
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

  describe('probe', () => {
    function answer(status: unknown[], version: unknown) {
      fetchSpy.mockImplementation(((url: string) => {
        const body = url.endsWith('/version') ? { data: version } : { data: status };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }) as unknown as typeof fetch);
    }

    it('reports the cluster name, the release and the node count', async () => {
      answer([
        { type: 'cluster', id: 'cluster', name: 'homelab', version: 3, quorate: 1, nodes: 2 },
        { type: 'node', id: 'node/pve1', name: 'pve1', online: 1 },
        { type: 'node', id: 'node/pve2', name: 'pve2', online: 1 },
      ], { version: '9.0.3', release: '9.0' });

      expect(await new ProxmoxClient(createConfig()).probe()).toEqual({ clusterName: 'homelab', release: '9.0', nodeCount: 2 });
    });

    it('names a standalone node after itself, and falls back to the version when no release is given', async () => {
      answer([{ type: 'node', id: 'node/pve1', name: 'pve1', online: 1 }], { version: '8.2.4' });

      expect(await new ProxmoxClient(createConfig()).probe()).toEqual({ clusterName: 'pve1', release: '8.2.4', nodeCount: 1 });
    });

    it('sorts a rejected token into token_rejected', async () => {
      fetchSpy.mockImplementation((() => Promise.resolve(new Response('authentication failure', { status: 401, statusText: 'Unauthorized' }))) as unknown as typeof fetch);

      const err = await new ProxmoxClient(createConfig()).probe().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProxmoxRequestError);
      expect((err as ProxmoxRequestError).kind).toBe('token_rejected');
    });

    it('treats a version answer off the expected shape as unreachable', async () => {
      answer([], { nope: true });

      const err = await new ProxmoxClient(createConfig()).getVersion().catch((e: unknown) => e);
      expect((err as ProxmoxRequestError).kind).toBe('unreachable');
    });
  });

  it('keeps the token secret out of a failure message that quotes it', async () => {
    const secret = 'sécret=with=equals';
    fetchSpy.mockImplementation((() => Promise.reject(new TypeError(`Header has invalid value: PVEAPIToken=root@pam!test=${secret}`))) as unknown as typeof fetch);

    const err = await new ProxmoxClient(createConfig({ tokenSecret: secret })).getClusterStatus().catch((e: unknown) => e) as ProxmoxRequestError;
    expect(err.message).not.toContain(secret);
    expect(err.detail).not.toContain(secret);
    expect(err.message).toContain('[redacted]');
  });
});

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { PortainerClient, PortainerConnectionManager } from '../portainer-client';

const originalConsoleError = console.error;

interface PortainerConfig {
  url: string;
  token: string;
  allowSelfSignedCerts?: boolean;
}

function createConfig(overrides?: Partial<PortainerConfig>): PortainerConfig {
  return {
    url: 'https://portainer.local:9443',
    token: 'ptr_test-api-key-12345',
    allowSelfSignedCerts: true,
    ...overrides,
  };
}

describe('PortainerClient', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
    console.error = mock(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    console.error = originalConsoleError;
  });

  it('should construct with correct base URL from config', async () => {
    const client = new PortainerClient(createConfig());
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ Version: '2.19' }), { status: 200 })
    );
    await client.testConnection();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callUrl = fetchSpy.mock.calls[0][0] as string;
    expect(callUrl).toBe('https://portainer.local:9443/api/system/status');
  });

  it('should include X-API-Key header', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );
    const client = new PortainerClient(createConfig());
    await client.testConnection();

    const callInit = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(callInit.headers).toEqual({
      'X-API-Key': 'ptr_test-api-key-12345',
    });
  });

  describe('testConnection', () => {
    it('should return true on success', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ Version: '2.19' }), { status: 200 })
      );
      const client = new PortainerClient(createConfig());
      const result = await client.testConnection();
      expect(result).toBe(true);
    });

    it('should return false on error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));
      const client = new PortainerClient(createConfig());
      const result = await client.testConnection();
      expect(result).toBe(false);
    });
  });

  describe('getEndpoints', () => {
    it('should return endpoints array', async () => {
      const mockData = [
        { Id: 1, Name: 'local', URL: 'unix:///var/run/docker.sock', PublicURL: '', Type: 1, Status: 1 },
        { Id: 2, Name: 'remote', URL: 'tcp://192.168.1.50:2375', PublicURL: '192.168.1.50', Type: 1, Status: 1 },
      ];
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockData), { status: 200 })
      );
      const client = new PortainerClient(createConfig());
      const result = await client.getEndpoints();
      expect(result).toEqual(mockData);
      expect(result).toHaveLength(2);
      const callUrl = fetchSpy.mock.calls[0][0] as string;
      expect(callUrl).toBe('https://portainer.local:9443/api/endpoints');
    });
  });

  describe('getStacks', () => {
    it('should return stacks array', async () => {
      const mockData = [
        { Id: 1, Name: 'mystack', Type: 2, EndpointId: 1, Status: 1, Env: [{ name: 'FOO', value: 'bar' }] },
      ];
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockData), { status: 200 })
      );
      const client = new PortainerClient(createConfig());
      const result = await client.getStacks();
      expect(result).toEqual(mockData);
      expect(result).toHaveLength(1);
      const callUrl = fetchSpy.mock.calls[0][0] as string;
      expect(callUrl).toBe('https://portainer.local:9443/api/stacks');
    });
  });

  describe('getStackFile', () => {
    it('should return stack file content', async () => {
      const mockData = { StackFileContent: 'version: "3"\nservices:\n  web:\n    image: nginx' };
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockData), { status: 200 })
      );
      const client = new PortainerClient(createConfig());
      const result = await client.getStackFile(42);
      expect(result).toEqual(mockData);
      const callUrl = fetchSpy.mock.calls[0][0] as string;
      expect(callUrl).toBe('https://portainer.local:9443/api/stacks/42/file');
    });
  });

  describe('redeployStack', () => {
    it('should call PUT with correct URL and body', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      );
      const client = new PortainerClient(createConfig());
      await client.redeployStack(5, 1);

      const callUrl = fetchSpy.mock.calls[0][0] as string;
      expect(callUrl).toBe('https://portainer.local:9443/api/stacks/5/git/redeploy?endpointId=1');

      const callInit = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(callInit.method).toBe('PUT');
      expect(callInit.headers).toEqual({
        'X-API-Key': 'ptr_test-api-key-12345',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(callInit.body as string)).toEqual({
        pullImage: true,
        prune: false,
        repositoryAuthentication: false,
      });
    });
  });

  describe('HTTP error handling', () => {
    it('should throw on non-OK response', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
      );
      const client = new PortainerClient(createConfig());
      await expect(client.getEndpoints()).rejects.toThrow('Portainer API error: 401');
    });
  });

  describe('self-signed cert options', () => {
    it('should not set TLS options when allowSelfSignedCerts is false', () => {
      const config = createConfig({ allowSelfSignedCerts: false });
      const client = new PortainerClient(config);

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      );
      client.testConnection();

      const callInit = fetchSpy.mock.calls[0][1] as any;
      expect(callInit.tls).toBeUndefined();
    });

    it('should set TLS options when allowSelfSignedCerts is true', async () => {
      const config = createConfig({ allowSelfSignedCerts: true });
      const client = new PortainerClient(config);

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      );
      await client.testConnection();

      const callInit = fetchSpy.mock.calls[0][1] as any;
      expect(callInit.tls).toEqual({ rejectUnauthorized: false });
    });
  });
});

describe('PortainerConnectionManager', () => {
  it('should cache clients by URL', () => {
    const manager = new PortainerConnectionManager();
    const config = createConfig();

    const client1 = manager.getClient(config);
    const client2 = manager.getClient(config);
    expect(client1).toBe(client2);
  });

  it('should create different clients for different URLs', () => {
    const manager = new PortainerConnectionManager();
    const client1 = manager.getClient(createConfig({ url: 'https://host1:9443' }));
    const client2 = manager.getClient(createConfig({ url: 'https://host2:9443' }));
    expect(client1).not.toBe(client2);
  });

  it('should clear all cached clients', () => {
    const manager = new PortainerConnectionManager();
    const client1 = manager.getClient(createConfig());
    manager.clearAll();
    const client2 = manager.getClient(createConfig());
    expect(client1).not.toBe(client2);
  });
});

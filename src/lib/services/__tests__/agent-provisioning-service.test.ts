import { describe, it, expect, mock } from 'bun:test';
import { provisionHostTls, toHttpsAgentUrl } from '../agent-provisioning-service';
import type { TlsCertMaterial } from '../agent-tls-cert-generator';

function makeDeps(overrides: Partial<{
  generateCert: (request: { hostname: string; ip?: string; extraDnsNames?: string[] }) => Promise<TlsCertMaterial>;
  storeCert: (hostName: string, certPem: string, keyPem: string) => Promise<void>;
  resolveIp: (hostname: string) => Promise<string | null>;
}> = {}) {
  const calls = { certRequests: [] as Array<{ hostname: string; ip?: string; extraDnsNames?: string[] }>, stored: [] as Array<[string, string, string]> };
  return {
    calls,
    deps: {
      generateCert: overrides.generateCert ?? mock(async (request: { hostname: string; ip?: string; extraDnsNames?: string[] }) => {
        calls.certRequests.push(request);
        return { certPem: 'CERT-PEM', keyPem: 'KEY-PEM' };
      }),
      storeCert: overrides.storeCert ?? mock(async (hostName: string, certPem: string, keyPem: string) => {
        calls.stored.push([hostName, certPem, keyPem]);
      }),
      resolveIp: overrides.resolveIp,
    },
  };
}

describe('provisionHostTls', () => {
  it('generates and stores the cert and rewrites the agent URL to https', async () => {
    const { calls, deps } = makeDeps({ resolveIp: async () => '192.168.1.10' });
    const result = await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
    expect(result.agentUrl).toBe('https://myhost.lan:9090');
    expect(result.certPem).toBe('CERT-PEM');
    expect(result.keyPem).toBe('KEY-PEM');
    expect(calls.certRequests[0]).toEqual({
      hostname: 'myhost.lan',
      ip: '192.168.1.10',
      extraDnsNames: ['hlm-agent'],
    });
    expect(calls.stored).toEqual([['myhost', 'CERT-PEM', 'KEY-PEM']]);
  });

  it('covers an IP-literal agent URL with an IP SAN and no resolution', async () => {
    const { calls, deps } = makeDeps();
    const result = await provisionHostTls('myhost', 'http://192.168.1.10:9090', deps);
    expect(result.agentUrl).toBe('https://192.168.1.10:9090');
    expect(calls.certRequests[0]?.hostname).toBe('192.168.1.10');
    expect(calls.certRequests[0]?.ip).toBe('192.168.1.10');
  });

  it('omits the IP SAN entry when resolution fails', async () => {
    const { calls, deps } = makeDeps({ resolveIp: async () => null });
    await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
    expect(calls.certRequests[0]?.ip).toBeUndefined();
  });

  it('omits the IP SAN entry when resolution rejects', async () => {
    const { calls, deps } = makeDeps({
      resolveIp: async () => {
        throw new Error('resolver down');
      },
    });
    await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
    expect(calls.certRequests[0]?.ip).toBeUndefined();
  });

  it('keeps a non-default https port and strips a trailing slash', async () => {
    const { deps } = makeDeps({ resolveIp: async () => null });
    const result = await provisionHostTls('myhost', 'http://myhost.lan/', deps);
    expect(result.agentUrl).toBe('https://myhost.lan');
  });

  it('rejects agent URLs with unsupported schemes', async () => {
    const { deps } = makeDeps();
    await expect(provisionHostTls('myhost', 'ftp://myhost.lan:9090', deps)).rejects.toThrow(
      "Agent URL must use http or https, got 'ftp:'",
    );
  });

  it('propagates cert generation failures', async () => {
    const { deps } = makeDeps({
      generateCert: async () => {
        throw new Error('openssl exploded');
      },
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow('openssl exploded');
  });

  it('the default IP resolver resolves localhost', async () => {
    const { calls, deps } = makeDeps();
    await provisionHostTls('myhost', 'http://localhost:9090', deps);
    expect(['127.0.0.1', '::1']).toContain(calls.certRequests[0]?.ip ?? '');
  });

  it('the default IP resolver returns null for an unresolvable name', async () => {
    const { calls, deps } = makeDeps();
    await provisionHostTls('myhost', 'http://host-that-does-not-resolve.invalid:9090', deps);
    expect(calls.certRequests[0]?.ip).toBeUndefined();
  }, 20000);
});

describe('toHttpsAgentUrl', () => {
  it('switches the scheme and keeps host and port', () => {
    expect(toHttpsAgentUrl(new URL('http://myhost.lan:9090/'))).toBe('https://myhost.lan:9090');
  });
});

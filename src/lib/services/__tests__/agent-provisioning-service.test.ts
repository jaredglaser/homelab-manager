import { describe, it, expect, mock } from 'bun:test';
import { provisionHostTls, isRestartConnectionLoss, toHttpsAgentUrl } from '../agent-provisioning-service';

const CERT_PEM = '-----BEGIN CERTIFICATE-----\nFAKECERT\n-----END CERTIFICATE-----\n';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface DepsOptions {
  fetchResponses?: Array<Response | Error>;
  healthResults?: Array<boolean>;
  resolveIp?: (hostname: string) => Promise<string | null>;
  caCertPem?: string | null;
  storeCertError?: Error;
}

function makeDeps(options: DepsOptions = {}) {
  const fetchCalls: FetchCall[] = [];
  const responses = [...(options.fetchResponses ?? [])];
  const fetchFn = mock(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? jsonResponse({});
  }) as unknown as typeof fetch;

  const healthCalls: Array<{ url: string; caCertPem: string | null }> = [];
  const healthResults = [...(options.healthResults ?? [])];
  const checkHealth = mock(async (url: string, _hostName: string, caCertPem: string | null) => {
    healthCalls.push({ url, caCertPem });
    const next = healthResults.shift();
    return next === undefined || next
      ? ({ healthy: true } as const)
      : ({ healthy: false, error: 'unreachable' } as const);
  });

  const delays: number[] = [];
  const sleepFn = mock(async (ms: number) => {
    delays.push(ms);
  });

  const stored: Array<[string, string]> = [];
  const storeCert = mock(async (hostName: string, certPem: string) => {
    if (options.storeCertError) throw options.storeCertError;
    stored.push([hostName, certPem]);
  });

  const deps = {
    getSigner: mock(async () => 'JWT-TOKEN'),
    storeCert,
    checkHealth,
    fetchFn,
    sleepFn,
    resolveIp: options.resolveIp,
    caCertPem: options.caCertPem,
  };

  return { deps, fetchCalls, fetchFn, healthCalls, delays, stored, storeCert, checkHealth };
}

function enrollResponse(): Response {
  return jsonResponse({ certPem: CERT_PEM });
}

describe('provisionHostTls', () => {
  it('enrolls, stores the cert, survives the restart connection loss, and polls https before returning the https URL', async () => {
    const { deps, fetchCalls, healthCalls, stored, delays } = makeDeps({
      fetchResponses: [enrollResponse(), new Error('Connection reset by peer')],
      healthResults: [false, true],
      resolveIp: async () => '192.168.1.10',
    });
    const result = await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
    expect(result.agentUrl).toBe('https://myhost.lan:9090');
    expect(result.certPem).toBe(CERT_PEM);

    expect(fetchCalls[0].url).toBe('http://myhost.lan:9090/tls/enroll');
    const enrollInit = fetchCalls[0].init as RequestInit & { body?: string };
    expect(enrollInit.method).toBe('POST');
    expect((enrollInit.headers as Record<string, string>).Authorization).toBe('Bearer ' + 'JWT-TOKEN');
    expect(JSON.parse(enrollInit.body ?? '{}')).toEqual({
      sans: ['myhost.lan', '192.168.1.10', 'localhost'],
    });

    expect(fetchCalls[1].url).toBe('http://myhost.lan:9090/containers/hlm-agent/restart');

    expect(stored).toEqual([['myhost', CERT_PEM]]);
    expect(healthCalls).toEqual([
      { url: 'https://myhost.lan:9090', caCertPem: CERT_PEM },
      { url: 'https://myhost.lan:9090', caCertPem: CERT_PEM },
    ]);
    expect(delays).toEqual([500, 1000]);
  });

  it('treats a restart timeout as success-unknown and keeps polling', async () => {
    const timeout = new DOMException('The operation timed out', 'TimeoutError');
    const { deps, healthCalls } = makeDeps({
      fetchResponses: [enrollResponse(), timeout],
      healthResults: [true],
    });
    const result = await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
    expect(result.agentUrl).toBe('https://myhost.lan:9090');
    expect(healthCalls).toHaveLength(1);
  });

  it('fails with the actionable copy when the agent never becomes healthy over https', async () => {
    const { deps } = makeDeps({
      fetchResponses: [enrollResponse(), new Error('socket hang up')],
      healthResults: [false, false, false, false, false, false],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /TLS provisioning failed: the agent did not become healthy over HTTPS \(unreachable\)\. Fix the agent, then re-run TLS provisioning from the Managed Hosts card\./,
    );
  });

  it('stores the cert and restarts before the first https probe', async () => {
    const { deps, stored, fetchCalls, healthCalls } = makeDeps({
      fetchResponses: [enrollResponse(), new Error('socket hang up')],
      healthResults: [true],
    });
    await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
    expect(stored).toHaveLength(1);
    expect(fetchCalls).toHaveLength(2);
    expect(healthCalls).toHaveLength(1);
    expect(healthCalls[0].url).toBe('https://myhost.lan:9090');
  });

  it('wraps an enroll HTTP error with the agent-provided detail', async () => {
    const { deps, storeCert } = makeDeps({
      fetchResponses: [jsonResponse({ error: 'Invalid SAN' }, 400)],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /TLS provisioning failed: the agent rejected the certificate request \(Invalid SAN\)\. Fix the agent, then re-run TLS provisioning/,
    );
    expect(storeCert).not.toHaveBeenCalled();
  });

  it('wraps an enroll network error', async () => {
    const { deps } = makeDeps({
      fetchResponses: [new Error('ECONNREFUSED')],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /TLS provisioning failed: the agent could not be reached to create its certificate/,
    );
  });

  it('refuses to store or poll when the agent returns no usable certificate', async () => {
    const { deps, storeCert } = makeDeps({
      fetchResponses: [jsonResponse({ certPem: 'not a pem' })],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /the agent returned no usable certificate/,
    );
    expect(storeCert).not.toHaveBeenCalled();
  });

  it('fails on a restart transport error that is not connection loss', async () => {
    const { deps, checkHealth } = makeDeps({
      fetchResponses: [enrollResponse(), Object.assign(new Error('permission denied'), { code: 'EACCES' })],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /the agent could not be restarted \(permission denied\)/,
    );
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('surfaces a plain-text restart error body', async () => {
    const { deps } = makeDeps({
      fetchResponses: [enrollResponse(), new Response('docker daemon down', { status: 500 })],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /the agent could not be restarted to serve the new certificate \(docker daemon down\)/,
    );
  });

  it('wraps a storeCert failure', async () => {
    const { deps } = makeDeps({
      fetchResponses: [enrollResponse()],
      storeCertError: new Error('db down'),
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /TLS provisioning failed: the certificate could not be stored \(db down\)/,
    );
  });

  it('fails with the agent-provided detail when the restart request answers an HTTP error', async () => {
    const { deps, checkHealth } = makeDeps({
      fetchResponses: [enrollResponse(), jsonResponse({ error: 'Container not found: hlm-agent' }, 404)],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /the agent could not be restarted to serve the new certificate \(Container not found: hlm-agent\)/,
    );
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('enrolls over https with the currently pinned cert during rotation', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [enrollResponse(), new Error('Connection reset by peer')],
      healthResults: [true],
      caCertPem: '-----BEGIN CERTIFICATE-----\nOLD\n-----END CERTIFICATE-----\n',
    });
    await provisionHostTls('myhost', 'https://myhost.lan:9090', deps);
    const enrollInit = fetchCalls[0].init as RequestInit & { tls?: { ca: string } };
    expect(enrollInit.tls?.ca).toContain('OLD');
  });

  it('sends no TLS pin over the plain http enrollment channel', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [enrollResponse(), new Error('Connection reset by peer')],
      healthResults: [true],
    });
    await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
    const enrollInit = fetchCalls[0].init as RequestInit & { tls?: { ca: string } };
    expect(enrollInit.tls).toBeUndefined();
  });

  it('omits the IP SAN when resolution fails or rejects, keeping the poll healthy', async () => {
    for (const resolveIp of [async () => null, async () => { throw new Error('resolver down'); }]) {
      const { deps, fetchCalls } = makeDeps({
        fetchResponses: [enrollResponse(), new Error('Connection reset by peer')],
        healthResults: [true],
        resolveIp,
      });
      await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
      const enrollInit = fetchCalls[0].init as RequestInit & { body?: string };
      expect(JSON.parse(enrollInit.body ?? '{}')).toEqual({ sans: ['myhost.lan', 'localhost'] });
    }
  });

  it('uses the agent URL hostname itself as an IP SAN for an IP-literal URL', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [enrollResponse(), new Error('Connection reset by peer')],
      healthResults: [true],
    });
    await provisionHostTls('myhost', 'http://192.168.1.10:9090', deps);
    const enrollInit = fetchCalls[0].init as RequestInit & { body?: string };
    expect(JSON.parse(enrollInit.body ?? '{}')).toEqual({ sans: ['192.168.1.10', 'localhost'] });
  });

  it('rejects agent URLs with unsupported schemes', async () => {
    const { deps } = makeDeps();
    await expect(provisionHostTls('myhost', 'ftp://myhost.lan:9090', deps)).rejects.toThrow(
      "Agent URL must use http or https, got 'ftp:'",
    );
  });

  it('keeps a non-default port and strips a trailing slash on the https flip', async () => {
    const { deps } = makeDeps({
      fetchResponses: [enrollResponse(), new Error('Connection reset by peer')],
      healthResults: [true],
    });
    const result = await provisionHostTls('myhost', 'http://myhost.lan:8443/', deps);
    expect(result.agentUrl).toBe('https://myhost.lan:8443');
  });

  it('the default IP resolver resolves localhost', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [enrollResponse(), new Error('Connection reset by peer')],
      healthResults: [true],
    });
    await provisionHostTls('myhost', 'http://localhost:9090', deps);
    const enrollInit = fetchCalls[0].init as RequestInit & { body?: string };
    const sans = JSON.parse(enrollInit.body ?? '{}').sans as string[];
    expect(sans).toContain('localhost');
    expect(sans.filter((san) => san === 'localhost')).toHaveLength(1);
  });

  it('the default IP resolver returns null for an unresolvable name', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [enrollResponse(), new Error('Connection reset by peer')],
      healthResults: [true],
    });
    await provisionHostTls('myhost', 'http://host-that-does-not-resolve.invalid:9090', deps);
    const enrollInit = fetchCalls[0].init as RequestInit & { body?: string };
    expect(JSON.parse(enrollInit.body ?? '{}').sans).toEqual([
      'host-that-does-not-resolve.invalid',
      'localhost',
    ]);
  }, 20000);
});

describe('isRestartConnectionLoss', () => {
  it('accepts connection resets, socket hangs, and timeouts', () => {
    expect(isRestartConnectionLoss(new Error('Connection reset by peer'))).toBe(true);
    expect(isRestartConnectionLoss(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRestartConnectionLoss(new Error('socket hang up'))).toBe(true);
    expect(isRestartConnectionLoss(new DOMException('The operation timed out', 'TimeoutError'))).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(isRestartConnectionLoss(new Error('Invalid SAN'))).toBe(false);
    expect(isRestartConnectionLoss(Object.assign(new Error('nope'), { code: 'EACCES' }))).toBe(false);
  });
});

describe('toHttpsAgentUrl', () => {
  it('switches the scheme and keeps host and port', () => {
    expect(toHttpsAgentUrl(new URL('http://myhost.lan:9090/'))).toBe('https://myhost.lan:9090');
  });
});

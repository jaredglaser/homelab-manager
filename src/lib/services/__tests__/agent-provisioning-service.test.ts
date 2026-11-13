import { describe, it, expect, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { provisionHostTls, isRestartConnectionLoss, toHttpsAgentUrl } from '../agent-provisioning-service';
import { certificateFingerprint } from '@/lib/crypto/cert-fingerprint';
import { enrollmentPayload } from '../../crypto/agent-jwt';

const CERT_PEM = '-----BEGIN CERTIFICATE-----\nFAKECERT\n-----END CERTIFICATE-----\n';
const OLD_CERT_PEM = '-----BEGIN CERTIFICATE-----\nOLD\n-----END CERTIFICATE-----\n';
const TEST_NONCE = 'test-nonce';
const TEST_SIGNATURE = 'test-signature';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The GET /tls/challenge reply that opens every enrollment handshake. */
function challengeResponse(nonce: string = TEST_NONCE): Response {
  return jsonResponse({ nonce, expiresAt: Date.now() + 60_000 });
}

interface DepsOptions {
  fetchResponses?: Array<Response | Error>;
  healthResults?: Array<boolean>;
  resolveIp?: (hostname: string) => Promise<string | null>;
  caCertPem?: string | null;
  storeCertError?: Error;
  signEnrollmentPayload?: (payload: string) => Promise<string>;
  allowPlaintextEnrollment?: boolean;
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

  // Detached-signature stub. The default is a constant so posted bodies stay easy to
  // assert, and tests that pin the payload/signature wiring inject their own signer.
  const signEnrollmentPayload = mock(
    options.signEnrollmentPayload ?? (async (_payload: string) => TEST_SIGNATURE),
  );

  const deps = {
    getSigner: mock(async () => 'JWT-TOKEN'),
    signEnrollmentPayload,
    storeCert,
    checkHealth,
    fetchFn,
    sleepFn,
    resolveIp: options.resolveIp,
    caCertPem: options.caCertPem,
    // Default to confirmed: these tests exercise the path after the operator accepted a plaintext
    // enrollment. The gate itself has its own test below.
    allowPlaintextEnrollment: options.allowPlaintextEnrollment ?? true,
  };

  return { deps, fetchCalls, fetchFn, healthCalls, delays, stored, storeCert, checkHealth, signEnrollmentPayload };
}

function enrollResponse(): Response {
  return jsonResponse({ certPem: CERT_PEM });
}

/** The response shape of an agent new enough to restart itself after enrollment. */
function selfRestartEnrollResponse(): Response {
  return jsonResponse({ certPem: CERT_PEM, selfRestartScheduled: true });
}

function restrictedModeRestartRejection(): Response {
  return jsonResponse(
    {
      error:
        'Agent TLS is configured but no certificate is enrolled yet, so this endpoint is not served over plain HTTP. Only /health, /auth/verify, /tls/enroll are available. Run TLS provisioning from the manager (Managed Hosts card), or see the agent TLS recovery steps in the self-hosting guide.',
    },
    403,
  );
}

describe('provisionHostTls', () => {
  it('enrolls over https, stores the cert, survives the restart connection loss, and polls https before returning the https URL', async () => {
    const { deps, fetchCalls, healthCalls, stored, delays } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse(), new Error('Connection reset by peer')],
      healthResults: [false, true],
      resolveIp: async () => '192.168.1.10',
      caCertPem: OLD_CERT_PEM,
    });
    const result = await provisionHostTls('myhost', 'https://myhost.lan:9090', deps);
    expect(result.agentUrl).toBe('https://myhost.lan:9090');
    expect(result.certPem).toBe(CERT_PEM);

    expect(fetchCalls[0].url).toBe('https://myhost.lan:9090/tls/challenge');
    expect(fetchCalls[1].url).toBe('https://myhost.lan:9090/tls/enroll');
    const enrollInit = fetchCalls[1].init as RequestInit & { body?: string };
    expect(enrollInit.method).toBe('POST');
    expect(JSON.parse(enrollInit.body ?? '{}')).toEqual({
      sans: ['myhost.lan', '192.168.1.10', 'localhost'],
      nonce: TEST_NONCE,
      signature: TEST_SIGNATURE,
    });

    expect(fetchCalls[2].url).toBe('https://myhost.lan:9090/containers/hlm-agent/restart');

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
      fetchResponses: [challengeResponse(), enrollResponse(), timeout],
      healthResults: [true],
      caCertPem: OLD_CERT_PEM,
    });
    const result = await provisionHostTls('myhost', 'https://myhost.lan:9090', deps);
    expect(result.agentUrl).toBe('https://myhost.lan:9090');
    expect(healthCalls).toHaveLength(1);
  });

  it('serializes concurrent rotations for the same host', async () => {
    const closed = new DOMException('The connection was closed.', 'AbortError');
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [
        challengeResponse(), enrollResponse(), closed, // rotation 1: challenge, enroll, restart (connection loss tolerated)
        challengeResponse(), enrollResponse(), closed, // rotation 2 queues behind 1, then challenge, enroll, restart
      ],
      healthResults: [true, true],
      caCertPem: OLD_CERT_PEM,
    });
    const [first, second] = await Promise.all([
      provisionHostTls('myhost', 'https://myhost.lan:9090', deps),
      provisionHostTls('myhost', 'https://myhost.lan:9090', deps),
    ]);
    expect(first.agentUrl).toBe('https://myhost.lan:9090');
    expect(second.agentUrl).toBe('https://myhost.lan:9090');
    // Serialized order: challenge, enroll, restart, challenge, enroll, restart. Rotation 2's enroll never lands in rotation 1's restart window.
    expect(fetchCalls.map((c) => c.url)).toEqual([
      'https://myhost.lan:9090/tls/challenge',
      'https://myhost.lan:9090/tls/enroll',
      'https://myhost.lan:9090/containers/hlm-agent/restart',
      'https://myhost.lan:9090/tls/challenge',
      'https://myhost.lan:9090/tls/enroll',
      'https://myhost.lan:9090/containers/hlm-agent/restart',
    ]);
  });

  it('treats Bun’s mid-flight connection close (AbortError) as success-unknown and keeps polling', async () => {
    // Bun reports the self-restart killing the socket as a plain AbortError with this message.
    // The older TimeoutError pattern does not catch it.
    const closed = new DOMException('The connection was closed.', 'AbortError');
    const { deps, healthCalls } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse(), closed],
      healthResults: [true],
      caCertPem: OLD_CERT_PEM,
    });
    const result = await provisionHostTls('myhost', 'https://myhost.lan:9090', deps);
    expect(result.agentUrl).toBe('https://myhost.lan:9090');
    expect(healthCalls).toHaveLength(1);
  });

  it('skips the restart request when the agent reports a scheduled self-restart', async () => {
    const { deps, fetchCalls, stored } = makeDeps({
      fetchResponses: [challengeResponse(), selfRestartEnrollResponse()],
      healthResults: [true],
      resolveIp: async () => '192.168.1.10',
    });
    const result = await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
    expect(result.agentUrl).toBe('https://myhost.lan:9090');
    // The agent restarts itself after enroll. The manager goes straight to the https poll.
    expect(fetchCalls.map((c) => c.url)).toEqual([
      'http://myhost.lan:9090/tls/challenge',
      'http://myhost.lan:9090/tls/enroll',
    ]);
    expect(stored).toEqual([['myhost', CERT_PEM]]);
  });

  it('tolerates the restricted-mode 403 on the restart request and lets the https poll decide', async () => {
    // First-boot restricted gate: agent too old to self-restart, or Docker capability off.
    const { deps, fetchCalls, healthCalls } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse(), restrictedModeRestartRejection()],
      healthResults: [true],
      caCertPem: OLD_CERT_PEM,
    });
    const result = await provisionHostTls('myhost', 'https://myhost.lan:9090', deps);
    expect(result.agentUrl).toBe('https://myhost.lan:9090');
    expect(fetchCalls).toHaveLength(3);
    expect(healthCalls).toHaveLength(1);
  });

  it('names the manual restart step in the poll-timeout error', async () => {
    const { deps, stored } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse()],
      healthResults: [false, false, false, false, false, false, false, false],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /did not serve the new certificate over HTTPS within the retry window \(unreachable\)\. If the agent could not restart itself.*docker restart hlm-agent/,
    );
    expect(stored).toEqual([]);
  });

  it('fails with the actionable copy when the agent never becomes healthy over https', async () => {
    const { deps, stored } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse()],
      healthResults: [false, false, false, false, false, false, false, false],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /TLS provisioning failed: the agent did not serve the new certificate over HTTPS within the retry window \(unreachable\)\. If the agent could not restart itself/,
    );
    expect(stored).toEqual([]);
  });

  it('stores the cert only after the first https probe succeeds', async () => {
    const { deps, stored, fetchCalls, healthCalls } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse()],
      healthResults: [true],
    });
    await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
    expect(fetchCalls).toHaveLength(2);
    expect(healthCalls).toHaveLength(1);
    expect(healthCalls[0].url).toBe('https://myhost.lan:9090');
    expect(stored).toEqual([['myhost', CERT_PEM]]);
  });

  it('bounds the challenge, enroll, and restart fetches with abort signals', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse(), new Error('Connection reset by peer')],
      healthResults: [true],
      caCertPem: OLD_CERT_PEM,
    });
    await provisionHostTls('myhost', 'https://myhost.lan:9090', deps);
    expect(fetchCalls).toHaveLength(3);
    for (const call of fetchCalls) {
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('strips brackets from an IPv6 literal agent URL before building SANs', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse()],
      healthResults: [true],
    });
    const result = await provisionHostTls('myhost', 'http://[2001:db8::1]:9090', deps);
    expect(result.agentUrl).toBe('https://[2001:db8::1]:9090');
    const enrollInit = fetchCalls[1].init as RequestInit & { body?: string };
    expect(JSON.parse(enrollInit.body ?? '{}').sans).toEqual(['2001:db8::1', 'localhost']);
  });

  it('wraps an enroll HTTP error with the agent-provided detail', async () => {
    const { deps, storeCert } = makeDeps({
      fetchResponses: [challengeResponse(), jsonResponse({ error: 'Invalid SAN' }, 400)],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /TLS enrollment failed: the agent rejected the certificate request \(Invalid SAN\)/,
    );
    expect(storeCert).not.toHaveBeenCalled();
  });

  it('reports the recovery steps when the enroll request itself cannot connect', async () => {
    // The challenge answered, so this is not "unreachable": it lands on the
    // bootstrap recovery copy, which is the one action that helps either way.
    const { deps } = makeDeps({
      fetchResponses: [challengeResponse(), new Error('ECONNREFUSED')],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /no pinned certificate for host 'myhost', and the enrollment could not be completed on http:\/\/myhost\.lan:9090/,
    );
  });

  it('retries the enrollment through a rotation restart window and succeeds', async () => {
    const connectError = new Error('Unable to connect. Is the computer able to access the url?');
    const { deps, fetchCalls, delays, healthCalls } = makeDeps({
      fetchResponses: [
        connectError,
        connectError,
        challengeResponse(),
        enrollResponse(),
        new DOMException('The connection was closed.', 'AbortError'),
      ],
      healthResults: [true],
      caCertPem: OLD_CERT_PEM,
    });
    const result = await provisionHostTls('myhost', 'https://myhost.lan:9090', deps);
    expect(result.agentUrl).toBe('https://myhost.lan:9090');
    // The whole two-request handshake is retried: two failed challenges, then one that enrolls.
    expect(fetchCalls.filter((c) => c.url.endsWith('/tls/challenge'))).toHaveLength(3);
    expect(fetchCalls.filter((c) => c.url.endsWith('/tls/enroll'))).toHaveLength(1);
    // The first two delays are the enrollment backoffs. The trailing 500ms is the first https health poll.
    expect(delays.slice(0, 2)).toEqual([2000, 4000]);
    expect(healthCalls).toHaveLength(1);
  });

  it('propagates a terminal HTTP rejection after connection retries instead of the unreachable copy', async () => {
    const connectError = new Error('Unable to connect. Is the computer able to access the url?');
    const { deps } = makeDeps({
      fetchResponses: [
        connectError,
        connectError,
        challengeResponse(),
        jsonResponse({ error: 'Unauthorized' }, 401),
      ],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /the agent rejected the certificate request \(Unauthorized\)/,
    );
  });

  it('reports a rotation-restart hint when enrollment retries are exhausted on both schemes', async () => {
    const connectError = new Error('Unable to connect. Is the computer able to access the url?');
    const { deps, delays } = makeDeps({
      fetchResponses: [connectError, connectError, connectError, connectError, connectError, connectError],
      caCertPem: CERT_PEM,
    });
    await expect(provisionHostTls('myhost', 'https://myhost.lan:9090', deps)).rejects.toThrow(
      /was unreachable on every scheme it could be reached on/,
    );
    expect(delays).toEqual([2000, 4000, 2000, 4000]);
  });

  it('a failed rotation does not block the next one for the same host', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [
        challengeResponse(),
        jsonResponse({ error: 'Invalid SAN' }, 400),
        challengeResponse(),
        enrollResponse(),
      ],
      healthResults: [true],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /the agent rejected the certificate request \(Invalid SAN\)/,
    );
    const second = await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
    expect(second.agentUrl).toBe('https://myhost.lan:9090');
    expect(fetchCalls.filter((c) => c.url.endsWith('/tls/enroll'))).toHaveLength(2);
  });

  it('refuses to store or poll when the agent returns no usable certificate', async () => {
    const { deps, storeCert } = makeDeps({
      fetchResponses: [challengeResponse(), jsonResponse({ certPem: 'not a pem' })],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /the agent returned no usable certificate/,
    );
    expect(storeCert).not.toHaveBeenCalled();
  });

  it('fails on a restart transport error that is not connection loss', async () => {
    const { deps, checkHealth } = makeDeps({
      fetchResponses: [
        challengeResponse(),
        enrollResponse(),
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      ],
      caCertPem: OLD_CERT_PEM,
    });
    await expect(provisionHostTls('myhost', 'https://myhost.lan:9090', deps)).rejects.toThrow(
      /TLS restart failed: could not reach the agent to restart it \(permission denied\)/,
    );
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('surfaces a plain-text restart error body', async () => {
    const { deps } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse(), new Response('docker daemon down', { status: 500 })],
      caCertPem: OLD_CERT_PEM,
    });
    await expect(provisionHostTls('myhost', 'https://myhost.lan:9090', deps)).rejects.toThrow(
      /TLS restart failed: the agent rejected the restart request \(docker daemon down\)/,
    );
  });

  it('wraps a storeCert failure', async () => {
    const { deps } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse()],
      storeCertError: new Error('db down'),
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /TLS provisioning failed: the certificate could not be stored \(db down\)/,
    );
  });

  it('names the missing Docker capability when the restart route is absent', async () => {
    // The container routes are only registered when the agent has Docker, so a 404 here is capability.
    const { deps } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse(), jsonResponse({ error: 'Not Found' }, 404)],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /no Docker capability, so it cannot restart itself/,
    );
  });

  it('fails with the agent-provided detail when the restart request answers an HTTP error', async () => {
    const { deps, checkHealth } = makeDeps({
      fetchResponses: [
        challengeResponse(),
        enrollResponse(),
        jsonResponse({ error: 'Container not found: hlm-agent' }, 500),
      ],
      caCertPem: OLD_CERT_PEM,
    });
    await expect(provisionHostTls('myhost', 'https://myhost.lan:9090', deps)).rejects.toThrow(
      /TLS restart failed: the agent rejected the restart request \(Container not found: hlm-agent\)/,
    );
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('enrolls over https with the currently pinned cert during rotation', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse(), new Error('Connection reset by peer')],
      healthResults: [true],
      caCertPem: OLD_CERT_PEM,
    });
    await provisionHostTls('myhost', 'https://myhost.lan:9090', deps);
    const enrollInit = fetchCalls[1].init as RequestInit & { tls?: { ca: string } };
    expect(enrollInit.tls?.ca).toContain('OLD');
  });

  it('refuses a plaintext enrollment of a known host until the operator confirms it', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [new Error('Was there a typo in the url or port?')],
      caCertPem: CERT_PEM,
      allowPlaintextEnrollment: false,
    });
    await expect(provisionHostTls('myhost', 'https://myhost.lan:9090', deps)).rejects.toThrow(
      /Plaintext enrollment confirmation required/,
    );
    // Nothing was enrolled and nothing was stored, so the host is exactly as it was.
    expect(fetchCalls.some((c) => c.url.endsWith('/tls/enroll'))).toBe(false);
  });

  it('sends no TLS pin over the plain http enrollment channel', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse()],
      healthResults: [true],
    });
    await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
    const enrollInit = fetchCalls[1].init as RequestInit & { tls?: { ca: string } };
    expect(enrollInit.tls).toBeUndefined();
  });

  it('bootstraps over the plain-HTTP sibling when the stored https URL holds no pin', async () => {
    // The stored https URL cannot verify the agent it is meant to enrol, so the
    // enrollment goes to the address the agent serves while it has no certificate.
    const { deps, fetchCalls, stored } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse()],
      healthResults: [true],
      caCertPem: null,
    });
    const result = await provisionHostTls('myhost', 'https://myhost.lan:9090', deps);

    expect(fetchCalls[0].url).toBe('http://myhost.lan:9090/tls/challenge');
    expect(fetchCalls[1].url).toBe('http://myhost.lan:9090/tls/enroll');
    expect((fetchCalls[1].init as RequestInit & { tls?: unknown }).tls).toBeUndefined();
    expect(result.agentUrl).toBe('https://myhost.lan:9090');
    expect(stored).toEqual([['myhost', CERT_PEM]]);
  });

  it('reports the recovery steps when no pin is held and nothing answers on plain HTTP', async () => {
    const connectError = new Error('Unable to connect. Is the computer able to access the url?');
    const { deps } = makeDeps({
      fetchResponses: [connectError, connectError, connectError],
      caCertPem: null,
    });
    await expect(provisionHostTls('myhost', 'https://myhost.lan:9090', deps)).rejects.toThrow(
      /no pinned certificate for host 'myhost', and the enrollment could not be completed on http:\/\/myhost\.lan:9090/,
    );
  });

  it('omits the IP SAN when resolution fails or rejects, keeping the poll healthy', async () => {
    for (const resolveIp of [async () => null, async () => { throw new Error('resolver down'); }]) {
      const { deps, fetchCalls } = makeDeps({
        fetchResponses: [challengeResponse(), enrollResponse()],
        healthResults: [true],
        resolveIp,
      });
      await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
      const enrollInit = fetchCalls[1].init as RequestInit & { body?: string };
      expect(JSON.parse(enrollInit.body ?? '{}').sans).toEqual(['myhost.lan', 'localhost']);
    }
  });

  it('uses the agent URL hostname itself as an IP SAN for an IP-literal URL', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse()],
      healthResults: [true],
    });
    await provisionHostTls('myhost', 'http://192.168.1.10:9090', deps);
    const enrollInit = fetchCalls[1].init as RequestInit & { body?: string };
    expect(JSON.parse(enrollInit.body ?? '{}').sans).toEqual(['192.168.1.10', 'localhost']);
  });

  it('rejects agent URLs with unsupported schemes', async () => {
    const { deps } = makeDeps();
    await expect(provisionHostTls('myhost', 'ftp://myhost.lan:9090', deps)).rejects.toThrow(
      "Agent URL must use http or https, got 'ftp:'",
    );
  });

  it('keeps a non-default port and strips a trailing slash on the https flip', async () => {
    const { deps } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse()],
      healthResults: [true],
    });
    const result = await provisionHostTls('myhost', 'http://myhost.lan:8443/', deps);
    expect(result.agentUrl).toBe('https://myhost.lan:8443');
  });

  it('the default IP resolver resolves localhost', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse()],
      healthResults: [true],
    });
    await provisionHostTls('myhost', 'http://localhost:9090', deps);
    const enrollInit = fetchCalls[1].init as RequestInit & { body?: string };
    const sans = JSON.parse(enrollInit.body ?? '{}').sans as string[];
    expect(sans).toContain('localhost');
    expect(sans.filter((san) => san === 'localhost')).toHaveLength(1);
  });

  it('the default IP resolver returns null for an unresolvable name', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse()],
      healthResults: [true],
    });
    await provisionHostTls('myhost', 'http://host-that-does-not-resolve.invalid:9090', deps);
    const enrollInit = fetchCalls[1].init as RequestInit & { body?: string };
    expect(JSON.parse(enrollInit.body ?? '{}').sans).toEqual([
      'host-that-does-not-resolve.invalid',
      'localhost',
    ]);
  }, 20000);
});

describe('provisionHostTls enrollment handshake', () => {
  it('digests a certificate the way the agent prints it', () => {
    const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from('hello').toString('base64')}\n-----END CERTIFICATE-----\n`;
    const expected = 'SHA256:' + createHash('sha256').update('hello').digest('base64').replace(/=+$/, '');
    expect(certificateFingerprint(pem)).toBe(expected);
  });

  it('pins the enrollment payload format the agent rebuilds', () => {
    // Same fixture as the agent's copy of this test, so a change on either
    // builder fails both suites instead of only failing at runtime.
    expect(enrollmentPayload('nonce-1', 'agent-1.lan', ['agent-1.lan', '10.0.0.5', 'localhost'])).toBe(
      'nonce-1\nagent-1.lan\nagent-1.lan,10.0.0.5,localhost',
    );
  });

  it('sends no Authorization header on the enrollment handshake, but the restart over https carries the bearer', async () => {
    // Plaintext enrollment: neither request may carry the bearer token.
    const plain = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse()],
      healthResults: [true],
    });
    await provisionHostTls('myhost', 'http://myhost.lan:9090', plain.deps);
    const plainEnroll = plain.fetchCalls.find((c) => c.url.endsWith('/tls/enroll'))!;
    expect((plainEnroll.init.headers as Record<string, string>).Authorization).toBeUndefined();

    // https rotation: the enrollment still carries no token, but the restart does.
    const tls = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse(), new Error('Connection reset by peer')],
      healthResults: [true],
      caCertPem: OLD_CERT_PEM,
    });
    await provisionHostTls('myhost', 'https://myhost.lan:9090', tls.deps);
    const tlsEnroll = tls.fetchCalls.find((c) => c.url.endsWith('/tls/enroll'))!;
    expect((tlsEnroll.init.headers as Record<string, string>).Authorization).toBeUndefined();
    const restart = tls.fetchCalls.find((c) => c.url.endsWith('/containers/hlm-agent/restart'))!;
    expect((restart.init.headers as Record<string, string>).Authorization).toBe('Bearer JWT-TOKEN');
  });

  it('signs the challenge nonce and posts the exact signature with the returned nonce', async () => {
    let signedPayload: string | null = null;
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [challengeResponse('server-nonce-42'), enrollResponse()],
      healthResults: [true],
      resolveIp: async () => '10.0.0.5',
      signEnrollmentPayload: async (payload) => {
        signedPayload = payload;
        return 'DETACHED-SIG';
      },
    });
    await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);

    const sans = ['myhost.lan', '10.0.0.5', 'localhost'];
    const enrollInit = fetchCalls[1].init as RequestInit & { body?: string };
    const body = JSON.parse(enrollInit.body ?? '{}');
    expect(body.sans).toEqual(sans);
    expect(body.nonce).toBe('server-nonce-42');
    expect(signedPayload as string | null).toBe(enrollmentPayload('server-nonce-42', 'myhost', sans));
    expect(body.signature).toBe('DETACHED-SIG');
  });

  it('does not send a restart request over a plaintext enrollment channel', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse()],
      healthResults: [true],
    });
    await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
    expect(fetchCalls.map((c) => c.url)).toEqual([
      'http://myhost.lan:9090/tls/challenge',
      'http://myhost.lan:9090/tls/enroll',
    ]);
  });

  it('sends a restart request over an https rotation', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse(), new Error('Connection reset by peer')],
      healthResults: [true],
      caCertPem: OLD_CERT_PEM,
    });
    await provisionHostTls('myhost', 'https://myhost.lan:9090', deps);
    expect(fetchCalls.map((c) => c.url)).toContain('https://myhost.lan:9090/containers/hlm-agent/restart');
  });

  it('refuses when the agent reports it has no TLS configured, without enrolling', async () => {
    // A plain-HTTP agent with no TLS paths writes a certificate it never reads, so say so at once
    // instead of polling HTTPS against a listener that does not exist.
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [
        jsonResponse({ nonce: TEST_NONCE, expiresAt: Date.now() + 60_000, tlsConfigured: false }),
      ],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /not configured for TLS, so it cannot serve HTTPS/,
    );
    expect(fetchCalls.some((c) => c.url.endsWith('/tls/enroll'))).toBe(false);
  });

  it('reports the recovery steps and never enrolls when the challenge cannot be reached', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [new Error('boom')],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /no pinned certificate for host 'myhost', and the enrollment could not be completed on http:\/\/myhost\.lan:9090\. The agent is either not running, or serving HTTPS with a certificate the manager no longer holds\. If it is running, remove its certificate files on the host, restart it, then run Rotate TLS again\. See the agent TLS recovery steps in the self-hosting guide\./,
    );
    expect(fetchCalls.some((c) => c.url.endsWith('/tls/enroll'))).toBe(false);
  });

  it('fails with the challenge copy and never enrolls when the challenge is rejected', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [jsonResponse({ error: 'nope' }, 503)],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /TLS enrollment failed: the agent refused the enrollment challenge \(nope\)/,
    );
    expect(fetchCalls.some((c) => c.url.endsWith('/tls/enroll'))).toBe(false);
  });

  it('fails with the challenge copy and never enrolls when the challenge carries no nonce', async () => {
    const { deps, fetchCalls } = makeDeps({
      fetchResponses: [jsonResponse({ expiresAt: Date.now() + 1000 })],
    });
    await expect(provisionHostTls('myhost', 'http://myhost.lan:9090', deps)).rejects.toThrow(
      /TLS enrollment failed: the agent returned no usable enrollment challenge/,
    );
    expect(fetchCalls.some((c) => c.url.endsWith('/tls/enroll'))).toBe(false);
  });
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

import { describe, it, expect, mock, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { provisionHostTls, isRestartConnectionLoss, isServedCertUnverifiable, isTransientEnrollmentFailure, toHttpsAgentUrl, TlsProvisionFailure } from '../agent-provisioning-service';
import { certificateFingerprint } from '@/lib/crypto/cert-fingerprint';
import { tlsFailureMessage } from '@/lib/errors/tls-failure-copy';
import { agentResponse } from '@/lib/test/agent-response';
import { enrollmentPayload } from '../../crypto/agent-jwt';
import { mockModule } from '@/lib/test/mock-module';
import { mockSetTimeout } from '@/lib/test/mock-timers';
import type * as DnsPromises from 'node:dns/promises';
import type { TlsFailureCode } from '@homelab-manager/agent/types';

// A real lookup waits out a lost UDP reply (2s resolver retry), which is the whole test budget.
const dnsLookup = mock((hostname: string): Promise<{ address: string; family: number }> =>
  hostname === 'localhost'
    ? Promise.resolve({ address: '127.0.0.1', family: 4 })
    : Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })),
);
mockModule<typeof DnsPromises>('node:dns/promises', (real) => ({ ...real, lookup: dnsLookup }));

const CERT_PEM = '-----BEGIN CERTIFICATE-----\nFAKECERT\n-----END CERTIFICATE-----\n';
const OLD_CERT_PEM = '-----BEGIN CERTIFICATE-----\nOLD\n-----END CERTIFICATE-----\n';
const TEST_NONCE = 'test-nonce';
const TEST_SIGNATURE = 'test-signature';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return agentResponse(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The GET /tls/challenge reply that opens every enrollment handshake. */
function challengeResponse(nonce: string = TEST_NONCE): Response {
  return jsonResponse({ nonce, expiresAt: Date.now() + 60_000 });
}

/** Asserts the failure code, so a reworded message cannot quietly change what the UI does with it. */
async function expectFailure(promise: Promise<unknown>, code: TlsFailureCode): Promise<TlsProvisionFailure> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(TlsProvisionFailure);
    expect((err as TlsProvisionFailure).code).toBe(code);
    return err as TlsProvisionFailure;
  }
  throw new Error(`Expected a failure with code '${code}', but the call resolved`);
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

/** Bun's rejection when the served certificate is not the pinned one, which is a re-enrolled agent. */
function staleCertError(): Error {
  return Object.assign(new TypeError('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
}

/** Bun's rejection when the certificate verifies but does not cover the address used to reach the agent. */
function altNameError(): Error {
  return Object.assign(new TypeError('ERR_TLS_CERT_ALTNAME_INVALID'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
}

/** Bun's rejection when AbortSignal.timeout fires: what a lost enroll response looks like. */
function timeoutError(): DOMException {
  return new DOMException('The operation timed out.', 'TimeoutError');
}

/** Bun's rejection when the agent process dies mid-request, which is the self-restart killing the socket. */
function resetError(): Error {
  return Object.assign(new TypeError('The socket connection was closed unexpectedly.'), { code: 'ECONNRESET' });
}

/** Bun's rejection when nothing is listening on the port yet, which a restart window produces. */
function connectRefusedError(): Error {
  return Object.assign(new TypeError('Unable to connect. Is the computer able to access the url?'), {
    code: 'ConnectionRefused',
  });
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
      code: 'restricted_plain_http',
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

  it('carries the agent-provided detail and code through an enroll HTTP error', async () => {
    const { deps, storeCert } = makeDeps({
      fetchResponses: [
        challengeResponse(),
        jsonResponse({ error: 'Invalid SAN', code: 'invalid_request' }, 400),
      ],
    });
    const err = await expectFailure(provisionHostTls('myhost', 'http://myhost.lan:9090', deps), 'invalid_request');
    expect(err.message).toContain('Invalid SAN');
    expect(storeCert).not.toHaveBeenCalled();
  });

  it('degrades to unexpected_agent_response when the agent sends no code', async () => {
    // An older agent, or a body this manager cannot classify, must not be reported as a known failure.
    const { deps } = makeDeps({
      fetchResponses: [challengeResponse(), jsonResponse({ error: 'Invalid SAN' }, 400)],
    });
    const err = await expectFailure(
      provisionHostTls('myhost', 'http://myhost.lan:9090', deps),
      'unexpected_agent_response',
    );
    expect(err.message).toContain('Invalid SAN');
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
    const connectError = connectRefusedError();
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

  it('retries the enrollment when the enroll response is lost to the agent self-restart, then succeeds', async () => {
    const { deps, delays, fetchCalls } = makeDeps({
      fetchResponses: [
        challengeResponse(),
        timeoutError(),
        challengeResponse(),
        enrollResponse(),
        new DOMException('The connection was closed.', 'AbortError'),
      ],
      healthResults: [true],
      caCertPem: CERT_PEM,
    });
    const result = await provisionHostTls('myhost', 'https://myhost.lan:9090', deps);
    expect(result.agentUrl).toBe('https://myhost.lan:9090');
    // The whole handshake is retried, so the second attempt enrolls and the https probe decides.
    expect(fetchCalls.filter((c) => c.url.endsWith('/tls/challenge'))).toHaveLength(2);
    expect(fetchCalls.filter((c) => c.url.endsWith('/tls/enroll'))).toHaveLength(2);
    expect(delays[0]).toBe(2000);
  });

  it('retries when the challenge connection is reset before the agent comes back', async () => {
    const { deps, fetchCalls, delays } = makeDeps({
      fetchResponses: [
        resetError(),
        challengeResponse(),
        enrollResponse(),
        new DOMException('The connection was closed.', 'AbortError'),
      ],
      healthResults: [true],
      caCertPem: CERT_PEM,
    });
    const result = await provisionHostTls('myhost', 'https://myhost.lan:9090', deps);
    expect(result.agentUrl).toBe('https://myhost.lan:9090');
    // The retry repeats the https candidate rather than falling through to the plain-HTTP sibling.
    expect(fetchCalls.filter((c) => c.url.endsWith('/tls/challenge')).map((c) => c.url)).toEqual([
      'https://myhost.lan:9090/tls/challenge',
      'https://myhost.lan:9090/tls/challenge',
    ]);
    expect(delays[0]).toBe(2000);
  });

  it('exhausts the retries on a lost response and points at the recovery steps', async () => {
    const { deps, delays } = makeDeps({
      // Three attempts on the https candidate, then the plain sibling, which a TLS listener resets.
      fetchResponses: [
        challengeResponse(),
        timeoutError(),
        challengeResponse(),
        timeoutError(),
        challengeResponse(),
        timeoutError(),
        resetError(),
      ],
      caCertPem: CERT_PEM,
    });
    const err = await expectFailure(provisionHostTls('myhost', 'https://myhost.lan:9090', deps), 'agent_unreachable');
    expect(err.message).toMatch(/self-hosting guide/i);
    expect(delays).toEqual([2000, 4000]);
  });

  it('reports an unverifiable certificate rather than an unreachable agent', async () => {
    const { deps, delays } = makeDeps({
      fetchResponses: [staleCertError(), staleCertError(), staleCertError(), resetError()],
      caCertPem: CERT_PEM,
    });
    const err = await expectFailure(provisionHostTls('myhost', 'https://myhost.lan:9090', deps), 'cert_unverifiable');
    expect(err.message).toMatch(/self-hosting guide/i);
    // A certificate the manager cannot verify is evidence about the agent, so nothing is retried.
    expect(delays).toEqual([]);
  });

  it('reports an address the pinned certificate no longer covers as the same state', async () => {
    const { deps, delays } = makeDeps({
      fetchResponses: [altNameError(), altNameError(), altNameError(), resetError()],
      caCertPem: CERT_PEM,
    });
    const err = await expectFailure(provisionHostTls('myhost', 'https://old-name.lan:9090', deps), 'cert_unverifiable');
    expect(err.message).toMatch(/self-hosting guide/i);
    expect(delays).toEqual([]);
  });

  it('propagates a terminal HTTP rejection after connection retries instead of the unreachable copy', async () => {
    const connectError = connectRefusedError();
    const { deps } = makeDeps({
      fetchResponses: [
        connectError,
        connectError,
        challengeResponse(),
        jsonResponse({ error: 'Unauthorized', code: 'signature_invalid' }, 401),
      ],
    });
    const err = await expectFailure(provisionHostTls('myhost', 'http://myhost.lan:9090', deps), 'signature_invalid');
    expect(err.message).toContain('Unauthorized');
  });

  it('reports a rotation-restart hint when enrollment retries are exhausted on both schemes', async () => {
    const connectError = connectRefusedError();
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
        jsonResponse({ error: 'Invalid SAN', code: 'invalid_request' }, 400),
        challengeResponse(),
        enrollResponse(),
      ],
      healthResults: [true],
    });
    await expectFailure(provisionHostTls('myhost', 'http://myhost.lan:9090', deps), 'invalid_request');
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
      fetchResponses: [challengeResponse(), enrollResponse(), agentResponse('docker daemon down', { status: 500 })],
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
    // An https rotation, because a plaintext channel never sends the restart request at all.
    const { deps } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse(), jsonResponse({ error: 'Not Found' }, 404)],
      caCertPem: CERT_PEM,
    });
    await expect(provisionHostTls('myhost', 'https://myhost.lan:9090', deps)).rejects.toThrow(
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
    const connectError = connectRefusedError();
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
    expect(dnsLookup).toHaveBeenCalledWith('localhost');
    expect(JSON.parse(enrollInit.body ?? '{}').sans).toEqual(['localhost', '127.0.0.1']);
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
  });

  it('the default IP resolver gives up on a lookup that never answers', async () => {
    dnsLookup.mockImplementationOnce(() => new Promise(() => undefined));
    const timers = mockSetTimeout({ fireImmediately: true });
    try {
      const { deps, fetchCalls } = makeDeps({
        fetchResponses: [challengeResponse(), enrollResponse()],
        healthResults: [true],
      });
      await provisionHostTls('myhost', 'http://myhost.lan:9090', deps);
      expect(timers.delays).toEqual([3000]);
      const enrollInit = fetchCalls[1].init as RequestInit & { body?: string };
      expect(JSON.parse(enrollInit.body ?? '{}').sans).toEqual(['myhost.lan', 'localhost']);
    } finally {
      timers.restore();
    }
  });
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

const PROXY_502_PAGE = '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>';

function proxyResponse(status = 502): Response {
  return new Response(PROXY_502_PAGE, { status, headers: { 'Content-Type': 'text/html' } });
}

const NOT_ANSWERING_MESSAGE =
  'Something other than the agent answered (HTTP 502). Check that the agent URL points at the agent and that any proxy in front of it is running, then try again.';

describe('provisionHostTls when something other than the agent answers', () => {
  it('reports a header-less 502 on the challenge as not the agent, and never enrolls', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { deps, fetchCalls } = makeDeps({ fetchResponses: [proxyResponse()] });
      const err = await expectFailure(provisionHostTls('myhost', 'http://myhost.lan:9090', deps), 'agent_not_answering');
      expect(err.message).toBe('HTTP 502');
      expect(tlsFailureMessage(err.code, err.message)).toBe(NOT_ANSWERING_MESSAGE);
      expect(fetchCalls.some((c) => c.url.endsWith('/tls/enroll'))).toBe(false);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(`HTTP 502: ${PROXY_502_PAGE}`));
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('http://myhost.lan:9090'));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('reports a header-less 502 on the enroll request as not the agent', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { deps, storeCert } = makeDeps({ fetchResponses: [challengeResponse(), proxyResponse()] });
      const err = await expectFailure(provisionHostTls('myhost', 'http://myhost.lan:9090', deps), 'agent_not_answering');
      expect(tlsFailureMessage(err.code, err.message)).toBe(NOT_ANSWERING_MESSAGE);
      expect(storeCert).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([502, 503, 504])('treats a header-less %i on the restart request like a lost connection, so the HTTPS poll decides and stores the cert', async (status) => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { deps, checkHealth, stored } = makeDeps({
        fetchResponses: [challengeResponse(), enrollResponse(), proxyResponse(status)],
        caCertPem: OLD_CERT_PEM,
        healthResults: [false, true],
      });
      const result = await provisionHostTls('myhost', 'https://myhost.lan:9090', deps);
      expect(result.certPem).toBe(CERT_PEM);
      expect(checkHealth).toHaveBeenCalledTimes(2);
      expect(stored).toEqual([['myhost', CERT_PEM]]);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(`the TLS restart request at https://myhost.lan:9090: HTTP ${status}: ${PROXY_502_PAGE}`));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('still fails with the poll error after a header-less 502 on restart when the agent never serves the cert, and stores nothing', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { deps, stored } = makeDeps({
        fetchResponses: [challengeResponse(), enrollResponse(), proxyResponse()],
        caCertPem: OLD_CERT_PEM,
        healthResults: [false, false, false, false, false, false, false, false],
      });
      const err = await expectFailure(provisionHostTls('myhost', 'https://myhost.lan:9090', deps), 'poll_timeout');
      expect(err.message).toContain('within the retry window (unreachable)');
      expect(stored).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([403, 500])('keeps a header-less %i on the restart request as not the agent, without polling', async (status) => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { deps, checkHealth } = makeDeps({
        fetchResponses: [challengeResponse(), enrollResponse(), proxyResponse(status)],
        caCertPem: OLD_CERT_PEM,
      });
      const err = await expectFailure(provisionHostTls('myhost', 'https://myhost.lan:9090', deps), 'agent_not_answering');
      expect(err.message).toBe(`HTTP ${status}`);
      expect(checkHealth).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not let a header-bearing 502 on the restart request pass as a lost connection', async () => {
    const { deps, checkHealth } = makeDeps({
      fetchResponses: [challengeResponse(), enrollResponse(), agentResponse(PROXY_502_PAGE, { status: 502, headers: { 'Content-Type': 'text/html' } })],
      caCertPem: OLD_CERT_PEM,
    });
    await expectFailure(provisionHostTls('myhost', 'https://myhost.lan:9090', deps), 'unexpected_agent_response');
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('reads a header-less 404 on the restart request as not the agent instead of a missing Docker capability', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { deps } = makeDeps({
        fetchResponses: [challengeResponse(), enrollResponse(), proxyResponse(404)],
        caCertPem: CERT_PEM,
      });
      const err = await expectFailure(provisionHostTls('myhost', 'https://myhost.lan:9090', deps), 'agent_not_answering');
      expect(err.message).toBe('HTTP 404');
    } finally {
      consoleError.mockRestore();
    }
  });

  describe('a redirect', () => {
    const REDIRECT_MESSAGE =
      'The agent URL redirected the request instead of answering it. Check that the URL stored for this host uses the right scheme (http or https) and the agent port, and that no proxy redirects it, then retry.';
    const redirect = (status = 301, headers: Record<string, string> = { Location: 'https://proxy.lan/agent' }) => new Response(null, { status, headers });
    const cases: Array<[string, Array<Response | Error>, string]> = [
      ['enrollment challenge', [redirect()], 'http://myhost.lan:9090'],
      ['enrollment', [challengeResponse(), redirect()], 'http://myhost.lan:9090'],
      ['restart', [challengeResponse(), enrollResponse(), redirect()], 'https://myhost.lan:9090'],
    ];

    it.each(cases)('fails the %s request with unexpected_redirect and the pinned copy, logging status and Location', async (step, fetchResponses, agentUrl) => {
      const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const { deps, checkHealth, stored } = makeDeps({ fetchResponses, caCertPem: OLD_CERT_PEM });
        const err = await expectFailure(provisionHostTls('myhost', agentUrl, deps), 'unexpected_redirect');
        expect(tlsFailureMessage(err.code, err.message)).toBe(REDIRECT_MESSAGE);
        expect(err.message).toBe(`TLS ${step} failed: the agent URL redirected the request (HTTP 301).`);
        expect(consoleError).toHaveBeenCalledWith(`[hosts] The TLS ${step} request at ${agentUrl} was redirected: HTTP 301 to https://proxy.lan/agent`);
        expect(checkHealth).not.toHaveBeenCalled();
        expect(stored).toEqual([]);
      } finally {
        consoleError.mockRestore();
      }
    });

    it.each([302, 307, 308])('reads a %i the same way', async (status) => {
      const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const { deps } = makeDeps({ fetchResponses: [redirect(status)] });
        await expectFailure(provisionHostTls('myhost', 'http://myhost.lan:9090', deps), 'unexpected_redirect');
      } finally {
        consoleError.mockRestore();
      }
    });

    it('reads a redirect that carries the agent header as a redirect too, and does not treat a restart redirect as a gateway error', async () => {
      const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const { deps } = makeDeps({
          fetchResponses: [challengeResponse(), enrollResponse(), agentResponse(null, { status: 302, headers: { Location: '/x' } })],
          caCertPem: OLD_CERT_PEM,
        });
        await expectFailure(provisionHostTls('myhost', 'https://myhost.lan:9090', deps), 'unexpected_redirect');
      } finally {
        consoleError.mockRestore();
      }
    });

    it('logs a missing Location as such, and a long one cut to a single bounded line', async () => {
      const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expectFailure(provisionHostTls('myhost', 'http://myhost.lan:9090', makeDeps({ fetchResponses: [redirect(301, {})] }).deps), 'unexpected_redirect');
        await expectFailure(provisionHostTls('myhost', 'http://myhost.lan:9090', makeDeps({ fetchResponses: [redirect(301, { Location: `http://x/${'a'.repeat(1000)}` })] }).deps), 'unexpected_redirect');
        const lines = consoleError.mock.calls.map((call) => String(call[0]));
        expect(lines[0]).toEndWith('HTTP 301 to no Location');
        expect(lines[1]?.length).toBeLessThan(500);
      } finally {
        consoleError.mockRestore();
      }
    });
  });

  it('still accepts a header-less 200 on the challenge, enroll and restart requests', async () => {
    const plain = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { deps, fetchCalls, stored } = makeDeps({
      fetchResponses: [plain({ nonce: TEST_NONCE, expiresAt: Date.now() + 60_000 }), plain({ certPem: CERT_PEM }), plain({ status: 'restarting' })],
      caCertPem: OLD_CERT_PEM,
    });

    const result = await provisionHostTls('myhost', 'https://myhost.lan:9090', deps);

    expect(result.certPem).toBe(CERT_PEM);
    expect(fetchCalls.map((c) => c.url)).toEqual([
      'https://myhost.lan:9090/tls/challenge',
      'https://myhost.lan:9090/tls/enroll',
      'https://myhost.lan:9090/containers/hlm-agent/restart',
    ]);
    expect(stored).toEqual([['myhost', CERT_PEM]]);
  });

  it('keeps unexpected_agent_response for an unrecognised body that carries the header', async () => {
    const { deps } = makeDeps({
      fetchResponses: [challengeResponse(), agentResponse(PROXY_502_PAGE, { status: 502, headers: { 'Content-Type': 'text/html' } })],
    });
    const err = await expectFailure(provisionHostTls('myhost', 'http://myhost.lan:9090', deps), 'unexpected_agent_response');
    expect(err.message).toContain(PROXY_502_PAGE);
  });

  it('does not take the not-answering code from an agent body that claims it', async () => {
    const { deps } = makeDeps({
      fetchResponses: [challengeResponse(), jsonResponse({ error: 'boom', code: 'agent_not_answering' }, 502)],
    });
    await expectFailure(provisionHostTls('myhost', 'http://myhost.lan:9090', deps), 'unexpected_agent_response');
  });

  it('leaves a network error to its own failure code', async () => {
    const { deps } = makeDeps({ fetchResponses: [new Error('boom')], caCertPem: CERT_PEM });
    await expectFailure(provisionHostTls('myhost', 'http://myhost.lan:9090', deps), 'agent_unreachable');
  });
});

describe('isServedCertUnverifiable', () => {
  it('reads the TLS verification codes and nothing else', () => {
    expect(isServedCertUnverifiable(staleCertError())).toBe(true);
    expect(isServedCertUnverifiable(altNameError())).toBe(true);
    expect(isServedCertUnverifiable(connectRefusedError())).toBe(false);
    expect(isServedCertUnverifiable(resetError())).toBe(false);
  });
});

describe('isTransientEnrollmentFailure', () => {
  it('retries the transport failures a self-restart produces', () => {
    expect(isTransientEnrollmentFailure(connectRefusedError())).toBe(true);
    expect(isTransientEnrollmentFailure(resetError())).toBe(true);
    expect(isTransientEnrollmentFailure(timeoutError())).toBe(true);
  });

  it('leaves a scheme mismatch and a missing pin to the next scheme instead of retrying', () => {
    expect(isTransientEnrollmentFailure(new TypeError('Was there a typo in the url or port?'))).toBe(false);
    expect(isTransientEnrollmentFailure(new Error('No pinned TLS certificate for this HTTPS agent URL'))).toBe(false);
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

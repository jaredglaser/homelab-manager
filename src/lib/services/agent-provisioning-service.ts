import { agentFetch, isTlsUrl, toPlainHttpUrl } from '@/lib/clients/agent-http';
import { enrollmentPayload } from '@/lib/crypto/agent-jwt';
import { certificateFingerprint } from '@/lib/crypto/cert-fingerprint';
import type { HealthCheckOutcome } from '@/lib/hosts/host-utils';

/** The compose healthcheck fetches https://localhost, so the cert must verify for it. */
const HEALTHCHECK_EXTRA_SANS = ['localhost'] as const;

/** The manager targets the agent container by its contractual compose name. */
const AGENT_CONTAINER_NAME = 'hlm-agent';

const IP_LOOKUP_TIMEOUT_MS = 3000;

/** Enroll involves two openssl invocations on the agent. 30s bounds a hung agent. */
const ENROLL_TIMEOUT_MS = 30_000;

/** Docker restart waits out the default 10s stop timeout. 30s leaves slack for the start and the response. */
const RESTART_TIMEOUT_MS = 30_000;

/** Same cadence as handleUpdateAgent's post-update poll, plus a 30s tail: ~61.5s total. */
const TLS_HEALTH_CHECK_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000] as const;

export interface TlsProvisionResult {
  /** https agent URL to store on the host record. Flipped only after a successful https probe. */
  agentUrl: string;
  certPem: string;
  /** True when the enrollment ran over plain HTTP, so the certificate was accepted on first use. */
  enrolledOverPlainHttp: boolean;
  /** Digest of the enrolled certificate, for comparison with the fingerprint the agent logs at startup. */
  fingerprint: string;
}

/** A transport-level failure. It may mean the agent serves the other scheme, so it is worth trying. */
class AgentChannelError extends Error {}

/** Thrown before anything changes, when the enrollment would run over plain HTTP without confirmation. */
export class PlaintextEnrollmentConfirmationRequired extends Error {}

export interface ProvisionHostTlsDeps {
  getSigner: () => Promise<string>;
  /** Detached signature over the enrollment payload, which replaces the bearer token on the enrollment call. */
  signEnrollmentPayload: (payload: string) => Promise<string>;
  /** Set once the operator has accepted that a plaintext enrollment trusts whatever certificate the agent presents. */
  allowPlaintextEnrollment?: boolean;
  storeCert: (hostName: string, certPem: string) => Promise<void>;
  checkHealth: (url: string, hostName: string, caCertPem: string | null) => Promise<HealthCheckOutcome>;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  /** Best-effort IP resolution for the SAN. Null skips the IP entry. */
  resolveIp?: (hostname: string) => Promise<string | null>;
  /** Currently pinned cert. Lets an https rotation enroll over the existing TLS channel. */
  caCertPem?: string | null;
}

// One rotation per host at a time. Concurrent rotations interleave enroll and
// restart windows: rotation B enrolls while rotation A's agent restart serves
// B's freshly-written cert, and B's pin then disagrees with what the agent
// actually serves ('self signed certificate' errors that are really races).
// Later rotations for the same host queue behind the in-flight one. A failed
// rotation does not block the next.
const rotationLocks = new Map<string, Promise<void>>();

async function withRotationLock<T>(hostName: string, fn: () => Promise<T>): Promise<T> {
  const previous = rotationLocks.get(hostName) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  rotationLocks.set(hostName, gate);
  try {
    await previous.catch(() => {});
    return await fn();
  } finally {
    if (rotationLocks.get(hostName) === gate) rotationLocks.delete(hostName);
    release();
  }
}

export async function provisionHostTls(
  hostName: string,
  agentUrl: string,
  deps: ProvisionHostTlsDeps,
): Promise<TlsProvisionResult> {
  return withRotationLock(hostName, () => runProvisionHostTls(hostName, agentUrl, deps));
}

async function runProvisionHostTls(
  hostName: string,
  agentUrl: string,
  deps: ProvisionHostTlsDeps,
): Promise<TlsProvisionResult> {
  const parsed = new URL(agentUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Agent URL must use http or https, got '${parsed.protocol}'`);
  }
  const baseUrl = agentUrl.replace(/\/+$/, '');
  const pin = deps.caCertPem ?? null;
  // The stored URL is tried first, then its plain-HTTP sibling. An agent serving no certificate
  // listens on that scheme, and a pin the manager no longer holds cannot reach either one, so
  // whichever answers is the one that enrolls.
  const enrollmentCandidates = parsed.protocol === 'https:' ? [baseUrl, toPlainHttpUrl(parsed)] : [baseUrl];
  // A URL like http://[::1]:9090 carries brackets in hostname. SANs take the bare literal.
  const hostname = parsed.hostname.replace(/^\[(.+)\]$/, '$1');
  const fetchFn = deps.fetchFn ?? fetch;
  const sleepFn = deps.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const ip = await resolveHostIp(hostname, deps.resolveIp ?? defaultResolveIp);
  const sans = buildSans(hostname, ip);

  const enrolled = await enrollAgainstCandidates(
    enrollmentCandidates,
    sans,
    hostName,
    deps,
    fetchFn,
    sleepFn,
    pin !== null,
  );
  const enrolledOverPlainHttp = enrolled.baseUrl !== baseUrl;
  if (enrolledOverPlainHttp) {
    console.warn(
      `[hosts] enrolled host '${hostName}' over plain HTTP: the agent served no certificate on ${baseUrl}, so the certificate it returned was accepted on first use.`,
    );
  }

  // A self-restarting agent needs no restart request, and the restricted gate would 403 it on a first
  // boot anyway. Skipped entirely on a plaintext channel, which must never carry the bearer token.
  if (!enrolled.selfRestartScheduled && isTlsUrl(enrolled.baseUrl)) {
    await requestRestart(enrolled.baseUrl, deps, fetchFn);
  }

  const httpsUrl = toHttpsAgentUrl(parsed);
  const certPem = enrolled.certPem;

  let lastResult: HealthCheckOutcome = { healthy: false, error: 'Health check not attempted' };
  for (const delay of TLS_HEALTH_CHECK_DELAYS_MS) {
    await sleepFn(delay);
    lastResult = await deps.checkHealth(httpsUrl, hostName, certPem);
    if (lastResult.healthy) {
      // Store the pin only after the https probe proves the agent serves the
      // new certificate, so a failed rotation never leaves the DB pin pointing
      // at a certificate the agent is not serving.
      await wrapFailure('the certificate could not be stored', () => deps.storeCert(hostName, certPem));
      return { agentUrl: httpsUrl, certPem, enrolledOverPlainHttp, fingerprint: certificateFingerprint(certPem) };
    }
  }

  throw new Error(
    `TLS provisioning failed: the agent did not serve the new certificate over HTTPS within the retry window (${lastResult.error}). `
      + 'If the agent could not restart itself (no Docker capability, or an agent version too old to self-restart), '
      + 'restart it manually (docker restart hlm-agent on the agent host) and retry provisioning.',
  );
}

function buildSans(hostname: string, ip: string | null): string[] {
  const sans: string[] = [hostname];
  if (ip && ip.toLowerCase() !== hostname.toLowerCase()) {
    sans.push(ip);
  }
  for (const extra of HEALTHCHECK_EXTRA_SANS) {
    if (!sans.some((existing) => existing.toLowerCase() === extra.toLowerCase())) {
      sans.push(extra);
    }
  }
  return sans;
}

/** No bearer token here: for a host with no certificate this runs over plain HTTP. */
async function fetchChallenge(
  baseUrl: string,
  deps: ProvisionHostTlsDeps,
  fetchFn: typeof fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await agentFetch(
      `${baseUrl}/tls/challenge`,
      { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS) },
      { caCertPem: deps.caCertPem ?? null },
      fetchFn,
    );
  } catch (err) {
    throw new AgentChannelError(
      `TLS enrollment failed: the agent could not be reached for a challenge (${err instanceof Error ? err.message : err}).`,
    );
  }
  if (!response.ok) {
    const detail = await readErrorBody(response);
    throw new Error(`TLS enrollment failed: the agent refused the enrollment challenge (${detail}).`);
  }
  const body = (await response.json().catch(() => null)) as { nonce?: unknown } | null;
  if (typeof body?.nonce !== 'string' || body.nonce === '') {
    throw new Error('TLS enrollment failed: the agent returned no usable enrollment challenge.');
  }
  return body.nonce;
}

async function enrollCert(
  baseUrl: string,
  sans: string[],
  hostName: string,
  deps: ProvisionHostTlsDeps,
  fetchFn: typeof fetch,
): Promise<{ certPem: string; selfRestartScheduled: boolean }> {
  const nonce = await fetchChallenge(baseUrl, deps, fetchFn);
  const signature = await deps.signEnrollmentPayload(enrollmentPayload(nonce, hostName, sans));
  let response: Response;
  try {
    response = await agentFetch(
      `${baseUrl}/tls/enroll`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sans, nonce, signature }),
        redirect: 'manual',
        signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS),
      },
      { caCertPem: deps.caCertPem ?? null },
      fetchFn,
    );
  } catch (err) {
    throw new AgentChannelError(
      `TLS enrollment failed: the agent could not be reached (${err instanceof Error ? err.message : err}).`,
    );
  }
  if (!response.ok) {
    const detail = await readErrorBody(response);
    throw new Error(
      `TLS enrollment failed: the agent rejected the certificate request (${detail}).`,
    );
  }
  const body = (await response.json().catch(() => null)) as
    | { certPem?: unknown; selfRestartScheduled?: unknown }
    | null;
  if (typeof body?.certPem !== 'string' || !body.certPem.includes('BEGIN CERTIFICATE')) {
    throw new Error('TLS enrollment failed: the agent returned no usable certificate.');
  }
  return { certPem: body.certPem, selfRestartScheduled: body.selfRestartScheduled === true };
}

async function requestRestart(
  baseUrl: string,
  deps: ProvisionHostTlsDeps,
  fetchFn: typeof fetch,
): Promise<void> {
  const jwt = await deps.getSigner();
  let response: Response;
  try {
    response = await agentFetch(
      `${baseUrl}/containers/${AGENT_CONTAINER_NAME}/restart`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + jwt },
        redirect: 'manual',
        signal: AbortSignal.timeout(RESTART_TIMEOUT_MS),
      },
      { caCertPem: deps.caCertPem ?? null },
      fetchFn,
    );
  } catch (err) {
    if (isRestartConnectionLoss(err)) {
      // The daemon kills the agent process during the restart, so the response
      // usually never completes. Connection loss here is success-unknown and
      // the https poll below is the real verdict.
      return;
    }
    throw new Error(
      `TLS restart failed: could not reach the agent to restart it (${err instanceof Error ? err.message : err}).`,
    );
  }
  if (!response.ok) {
    const detail = await readErrorBody(response);
    if (response.status === 403 && detail.startsWith('Agent TLS is configured but no certificate is enrolled yet')) {
      // First-boot restricted gate rejects the restart by design. Agents new enough self-restart on their own.
      // The https poll below is the real verdict, and its timeout message carries the manual-restart step.
      return;
    }
    throw new Error(
      `TLS restart failed: the agent rejected the restart request (${detail}).`,
    );
  }
}

/**
 * True for the transport-level failures a self-restart produces mid-response:
 * the socket dies with the agent process, or the probe times out waiting for a
 * response that will never arrive.
 */
export function isRestartConnectionLoss(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'TimeoutError') return true;
  // Bun reports the self-restart killing the socket as AbortError("The connection was closed."): the request was sent and no response will ever come.
  if (err instanceof DOMException && err.name === 'AbortError' && /connection (was )?closed/i.test(err.message)) return true;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /ECONNRESET|EPIPE|ECONNABORTED/i.test(code)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /econnreset|connection reset|socket hang up|epipe|aborted|timeout/i.test(message);
}

async function wrapFailure(reason: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    throw new Error(
      `TLS provisioning failed: ${reason} (${err instanceof Error ? err.message : err}).`,
    );
  }
}

async function readErrorBody(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed?.error === 'string') return parsed.error;
  } catch {
    // Body was not JSON. Keep the raw text.
  }
  return raw || `unexpected status ${response.status}`;
}

/**
 * Enrolls on the first channel that answers. A host whose certificate was removed serves plain HTTP,
 * so a connection-shaped failure on one candidate means the other scheme is worth trying.
 */
async function enrollAgainstCandidates(
  candidates: string[],
  sans: string[],
  hostName: string,
  deps: ProvisionHostTlsDeps,
  fetchFn: typeof fetch,
  sleepFn: (ms: number) => Promise<void>,
  pinHeld: boolean,
): Promise<{ certPem: string; selfRestartScheduled: boolean; baseUrl: string }> {
  // A rotation restarts the agent for up to ~10s (docker stop + start), so an immediately following
  // rotation can land inside that window and see the connection refused.
  const ENROLL_RETRIES = 2;
  for (const [index, candidate] of candidates.entries()) {
    // The plaintext sibling only happens for a host the manager already knows, and it trusts whatever
    // certificate comes back, so it needs an explicit confirmation before anything is changed.
    if (index > 0 && !deps.allowPlaintextEnrollment) {
      throw new PlaintextEnrollmentConfirmationRequired(
        `Plaintext enrollment confirmation required: host '${hostName}' is serving plain HTTP, so the certificate it presents would be accepted on first use.`,
      );
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const enrolled = await enrollCert(candidate, sans, hostName, deps, fetchFn);
        return { ...enrolled, baseUrl: candidate };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < ENROLL_RETRIES && /unable to connect/i.test(message)) {
          await sleepFn(2000 + attempt * 2000);
          continue;
        }
        // A terminal HTTP rejection must reach the wizard's key-mismatch mapping rather than being
        // retried against another scheme.
        if (!(err instanceof AgentChannelError)) throw err;
        break;
      }
    }
  }
  if (!pinHeld) {
    throw new Error(missingPinRecovery(hostName, candidates[candidates.length - 1] ?? 'the agent'));
  }
  throw new Error(
    'TLS enrollment failed: the agent was unreachable on every scheme it could be reached on. It may be restarting from a recent rotation. Retry in a few seconds.',
  );
}

/** A missing pin is the one failure retrying cannot fix: the agent is either down or serving a certificate the manager no longer holds. */
function missingPinRecovery(hostName: string, plainHttpUrl: string): string {
  return `The manager has no pinned certificate for host '${hostName}', and the enrollment could not be completed on ${plainHttpUrl}. `
    + 'The agent is either not running, or serving HTTPS with a certificate the manager no longer holds. '
    + 'If it is running, remove its certificate files on the host, restart it, then run Rotate TLS again. '
    + 'See the agent TLS recovery steps in the self-hosting guide.';
}

export function toHttpsAgentUrl(parsed: URL): string {
  const https = new URL(parsed.toString());
  https.protocol = 'https:';
  return https.toString().replace(/\/$/, '');
}

async function resolveHostIp(hostname: string, resolveIp: (hostname: string) => Promise<string | null>): Promise<string | null> {
  if (isIpLiteral(hostname)) return hostname;
  try {
    return await resolveIp(hostname);
  } catch {
    return null;
  }
}

function isIpLiteral(value: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4) return ipv4.slice(1).every((octet) => Number(octet) <= 255);
  return /^[0-9a-fA-F:]+$/.test(value) && value.includes(':');
}

async function defaultResolveIp(hostname: string): Promise<string | null> {
  const { lookup } = await import('node:dns/promises');
  const result = await Promise.race([
    lookup(hostname).then((r) => r.address),
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), IP_LOOKUP_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
  return result ?? null;
}

import { agentFetch, isTlsUrl, singleLine, toPlainHttpUrl, MISSING_PIN_RECOVERY_HINT } from '@/lib/clients/agent-http';
import { notAnsweringLogLine, readNotAnsweringFailure } from '@/lib/clients/agent-identity';
import { enrollmentPayload } from '@/lib/crypto/agent-jwt';
import { certificateFingerprint } from '@/lib/crypto/cert-fingerprint';
import type { HealthCheckOutcome } from '@/lib/hosts/host-utils';
import { isTlsFailureCode, type TlsFailureCode } from '@homelab-manager/agent/types';

/** The agent image's healthcheck fetches https://localhost with this cert as its CA, so the cert must verify for it. */
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
class AgentChannelError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

/**
 * A failure the operator can act on: the code says what to do and the message says why. The server
 * function turns these into a discriminated result, so the UI maps a code to its fix instead of
 * matching on prose that a later reword would silently break.
 */
export class TlsProvisionFailure extends Error {
  readonly code: TlsFailureCode;

  constructor(code: TlsFailureCode, message: string) {
    super(message);
    this.name = 'TlsProvisionFailure';
    this.code = code;
  }
}

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
    throw new TlsProvisionFailure('invalid_request', `Agent URL must use http or https, got '${parsed.protocol}'`);
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
      await wrapFailure('store_failed', 'the certificate could not be stored', () => deps.storeCert(hostName, certPem));
      return { agentUrl: httpsUrl, certPem, enrolledOverPlainHttp, fingerprint: certificateFingerprint(certPem) };
    }
  }

  throw new TlsProvisionFailure(
    'poll_timeout',
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
      `TLS enrollment failed: the enrollment challenge could not be completed because ${channelFailureReason(err)} (${err instanceof Error ? err.message : err}).`,
      err,
    );
  }
  if (!response.ok) {
    throwIfRedirected(response, baseUrl, 'enrollment challenge');
    await throwIfNotAnswering(response, baseUrl, 'enrollment challenge');
    const detail = await readErrorDetail(response);
    throw new TlsProvisionFailure(
      detail.code ?? 'unexpected_agent_response',
      `TLS enrollment failed: the agent refused the enrollment challenge (${detail.message}).`,
    );
  }
  const body = (await response.json().catch(() => null)) as { nonce?: unknown; tlsConfigured?: unknown } | null;
  if (typeof body?.nonce !== 'string' || body.nonce === '') {
    throw new TlsProvisionFailure(
      'unexpected_agent_response',
      'TLS enrollment failed: the agent returned no usable enrollment challenge.',
    );
  }
  if (body.tlsConfigured === false) {
    throw new TlsProvisionFailure(
      'not_configured_for_tls',
      'This agent is not configured for TLS, so it cannot serve HTTPS. Set TLS_CERT_PATH and TLS_KEY_PATH on the agent service, restart it, and retry.',
    );
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
      `TLS enrollment failed: the enrollment request could not be completed because ${channelFailureReason(err)} (${err instanceof Error ? err.message : err}).`,
      err,
    );
  }
  if (!response.ok) {
    throwIfRedirected(response, baseUrl, 'enrollment');
    await throwIfNotAnswering(response, baseUrl, 'enrollment');
    const detail = await readErrorDetail(response);
    // The agent names the failure now, so the manager no longer guesses from the status code: a 500
    // used to read as a rejected request, and a 4xx as a refusal, whatever had actually gone wrong.
    throw new TlsProvisionFailure(
      detail.code ?? 'unexpected_agent_response',
      `TLS enrollment failed: ${detail.message}`,
    );
  }
  const body = (await response.json().catch(() => null)) as
    | { certPem?: unknown; selfRestartScheduled?: unknown }
    | null;
  if (typeof body?.certPem !== 'string' || !body.certPem.includes('BEGIN CERTIFICATE')) {
    throw new TlsProvisionFailure(
      'no_cert_returned',
      'TLS enrollment failed: the agent returned no usable certificate.',
    );
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
    throw new TlsProvisionFailure(
      'agent_unreachable',
      `TLS restart failed: could not reach the agent to restart it (${err instanceof Error ? err.message : err}).`,
    );
  }
  if (!response.ok) {
    throwIfRedirected(response, baseUrl, 'restart');
    // A proxy's gateway error stands where the dying agent's dropped connection would, so the HTTPS poll below decides.
    if (await throwIfNotAnswering(response, baseUrl, 'restart', GATEWAY_STATUSES)) return;
    const detail = await readErrorDetail(response);
    if (response.status === 403 && detail.code === 'restricted_plain_http') {
      // First-boot restricted gate rejects the restart by design. Agents new enough self-restart on their own.
      // The https poll below is the real verdict, and its timeout message carries the manual-restart step.
      return;
    }
    if (response.status === 404) {
      // The container routes only exist when the agent has Docker, so this is capability, not refusal.
      throw new TlsProvisionFailure(
        'restart_unavailable',
        'This agent has no Docker capability, so it cannot restart itself. Restart it manually '
          + '(docker restart hlm-agent on the agent host) and retry provisioning.',
      );
    }
    throw new TlsProvisionFailure(
      detail.code ?? 'unexpected_agent_response',
      `TLS restart failed: the agent rejected the restart request (${detail.message}).`,
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
  // eslint-disable-next-line local/no-error-message-matching -- Bun reports the self-restart socket kill as AbortError, which carries no code
  if (err instanceof DOMException && err.name === 'AbortError' && /connection (was )?closed/i.test(err.message)) return true;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /ECONNRESET|EPIPE|ECONNABORTED/i.test(code)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /econnreset|connection reset|socket hang up|epipe|aborted|timeout/i.test(message);
}

/** Bun's fetch rejection when nothing is listening on the port yet: a TypeError carrying this code. */
function isConnectionRefused(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ConnectionRefused';
}

/** Transport failures worth another attempt here. A scheme mismatch falls through to the sibling URL instead. */
export function isTransientEnrollmentFailure(err: unknown): boolean {
  return isConnectionRefused(err) || isRestartConnectionLoss(err);
}

/**
 * The OpenSSL codes Bun reports when the pinned certificate does not verify for the host: the served
 * certificate is not the pinned one, or its SANs do not cover the address stored for the host. The
 * first is a re-enrolled agent, the second an address the certificate no longer covers. Measured on
 * Bun 1.4.4.
 */
const UNVERIFIABLE_SERVED_CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** True when the agent answered the handshake with a certificate this manager cannot verify. */
export function isServedCertUnverifiable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && UNVERIFIABLE_SERVED_CERT_CODES.has(code);
}

/** What the manager could tell about a transport failure, so its own line says that instead of flattening it. */
function channelFailureReason(err: unknown): string {
  return isServedCertUnverifiable(err)
    ? 'the agent served a certificate the manager cannot verify'
    : 'the agent could not be reached';
}

/**
 * True when another attempt at this candidate could plausibly succeed: the socket died with the agent
 * process, the probe timed out, or the restart window still has the port closed. A reset on the plain
 * HTTP sibling is excluded, since that is a TLS listener answering a plain request.
 */
function isWorthRetrying(candidate: string, cause: unknown): boolean {
  return isTlsUrl(candidate) ? isTransientEnrollmentFailure(cause) : isConnectionRefused(cause);
}

async function wrapFailure(code: TlsFailureCode, reason: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    throw new TlsProvisionFailure(
      code,
      `TLS provisioning failed: ${reason} (${err instanceof Error ? err.message : err}).`,
    );
  }
}

const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

function throwIfRedirected(response: Response, baseUrl: string, step: string): void {
  if (response.type !== 'opaqueredirect' && (response.status < 300 || response.status >= 400)) return;
  console.error(`[hosts] The TLS ${step} request at ${baseUrl} was redirected: HTTP ${response.status} to ${singleLine(response.headers.get('location') ?? 'no Location')}`);
  throw new TlsProvisionFailure('unexpected_redirect', `TLS ${step} failed: the agent URL redirected the request (HTTP ${response.status}).`);
}

/** Returns true when something other than the agent answered with a status in `tolerated`, so the caller carries on. */
async function throwIfNotAnswering(response: Response, baseUrl: string, step: string, tolerated?: ReadonlySet<number>): Promise<boolean> {
  const failure = await readNotAnsweringFailure(response);
  if (!failure) return false;
  console.error(`[hosts] ${notAnsweringLogLine(failure, `the TLS ${step} request at ${baseUrl}`)}`);
  if (tolerated?.has(failure.status)) return true;
  throw new TlsProvisionFailure(failure.code, failure.detail);
}

interface AgentErrorDetail {
  message: string;
  /** The agent's machine-readable reason. Absent when it sent prose only, or a code this manager does not know. */
  code?: TlsFailureCode;
}

async function readErrorDetail(response: Response): Promise<AgentErrorDetail> {
  const raw = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; code?: unknown };
    if (typeof parsed?.error === 'string') {
      return isTlsFailureCode(parsed.code)
        ? { message: parsed.error, code: parsed.code }
        : { message: parsed.error };
    }
  } catch {
    // Body was not JSON. Keep the raw text.
  }
  return { message: raw || `unexpected status ${response.status}` };
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
  let sawUnverifiableCert = false;
  for (const [index, candidate] of candidates.entries()) {
    // The plaintext sibling only happens for a host the manager already knows, and it trusts whatever
    // certificate comes back, so it needs an explicit confirmation before anything is changed.
    if (index > 0 && !deps.allowPlaintextEnrollment) {
      throw new TlsProvisionFailure(
        'plaintext_confirmation_required',
        `Plaintext enrollment confirmation required: host '${hostName}' is serving plain HTTP, so the certificate it presents would be accepted on first use.`,
      );
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const enrolled = await enrollCert(candidate, sans, hostName, deps, fetchFn);
        return { ...enrolled, baseUrl: candidate };
      } catch (err) {
        if (!(err instanceof AgentChannelError)) throw err;
        if (isServedCertUnverifiable(err.cause)) sawUnverifiableCert = true;
        // Retry only a transient transport failure, read from the cause the wrapper would otherwise flatten.
        if (attempt < ENROLL_RETRIES && isWorthRetrying(candidate, err.cause)) {
          await sleepFn(2000 + attempt * 2000);
          continue;
        }
        break;
      }
    }
  }
  if (!pinHeld) {
    throw new TlsProvisionFailure(
      'pin_missing',
      missingPinRecovery(hostName, candidates[candidates.length - 1] ?? 'the agent'),
    );
  }
  if (sawUnverifiableCert) {
    throw new TlsProvisionFailure(
      'cert_unverifiable',
      `TLS enrollment failed: the manager cannot verify the certificate the agent serves for host '${hostName}'. `
        + `It may have been re-issued since this host was enrolled, or the address stored for it may no longer match. ${MISSING_PIN_RECOVERY_HINT}`,
    );
  }
  throw new TlsProvisionFailure(
    'agent_unreachable',
    'TLS enrollment failed: the agent was unreachable on every scheme it could be reached on. It may be '
      + 'restarting from a recent rotation, or it may have already enrolled: an agent that restarts serving '
      + `HTTPS only holds a certificate the manager cannot verify. Retry in a few seconds. ${MISSING_PIN_RECOVERY_HINT}`,
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

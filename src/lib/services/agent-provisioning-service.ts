import { agentFetch } from '@/lib/clients/agent-http';
import type { HealthCheckOutcome } from '@/lib/hosts/host-utils';

/** The compose healthcheck fetches https://localhost, so the cert must verify for it. */
const HEALTHCHECK_EXTRA_SANS = ['localhost'] as const;

/** The manager targets the agent container by its contractual compose name. */
const AGENT_CONTAINER_NAME = 'hlm-agent';

const IP_LOOKUP_TIMEOUT_MS = 3000;

/** Enroll involves two openssl invocations on the agent; 30s bounds a hung agent. */
const ENROLL_TIMEOUT_MS = 30_000;

/** Docker restart waits out the default 10s stop timeout; 30s leaves slack for the start and the response. */
const RESTART_TIMEOUT_MS = 30_000;

/** Same cadence as handleUpdateAgent's post-update poll: 0.5s to 16s, ~31.5s total. */
const TLS_HEALTH_CHECK_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 16000] as const;

export interface TlsProvisionResult {
  /** https agent URL to store on the host record; flipped only after a successful https probe. */
  agentUrl: string;
  certPem: string;
}

export interface ProvisionHostTlsDeps {
  getSigner: () => Promise<string>;
  storeCert: (hostName: string, certPem: string) => Promise<void>;
  checkHealth: (url: string, hostName: string, caCertPem: string | null) => Promise<HealthCheckOutcome>;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  /** Best-effort IP resolution for the SAN; null skips the IP entry. */
  resolveIp?: (hostname: string) => Promise<string | null>;
  /** Currently pinned cert; lets an https rotation enroll over the existing TLS channel. */
  caCertPem?: string | null;
}

const RERUN_ADVICE = 'Fix the agent, then re-run TLS provisioning from the Managed Hosts card.';

export async function provisionHostTls(
  hostName: string,
  agentUrl: string,
  deps: ProvisionHostTlsDeps,
): Promise<TlsProvisionResult> {
  const parsed = new URL(agentUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Agent URL must use http or https, got '${parsed.protocol}'`);
  }
  const baseUrl = agentUrl.replace(/\/+$/, '');
  // A URL like http://[::1]:9090 carries brackets in hostname; SANs take the bare literal.
  const hostname = parsed.hostname.replace(/^\[(.+)\]$/, '$1');
  const fetchFn = deps.fetchFn ?? fetch;
  const sleepFn = deps.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const ip = await resolveHostIp(hostname, deps.resolveIp ?? defaultResolveIp);
  const sans = buildSans(hostname, ip);

  const certPem = await enrollCert(baseUrl, sans, deps, fetchFn);

  await requestRestart(baseUrl, deps, fetchFn);

  const httpsUrl = toHttpsAgentUrl(parsed);

  let lastResult: HealthCheckOutcome = { healthy: false, error: 'Health check not attempted' };
  for (const delay of TLS_HEALTH_CHECK_DELAYS_MS) {
    await sleepFn(delay);
    lastResult = await deps.checkHealth(httpsUrl, hostName, certPem);
    if (lastResult.healthy) {
      // Store the pin only after the https probe proves the agent serves the
      // new certificate, so a failed rotation never leaves the DB pin pointing
      // at a certificate the agent is not serving.
      await wrapFailure('the certificate could not be stored', () => deps.storeCert(hostName, certPem));
      return { agentUrl: httpsUrl, certPem };
    }
  }

  throw new Error(
    `TLS provisioning failed: the agent did not become healthy over HTTPS (${lastResult.error}). Provisioning may be incomplete: the agent may serve a certificate the manager has not pinned. Re-run TLS provisioning from the Managed Hosts card, or follow the agent TLS recovery steps in the self-hosting README.`,
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

async function enrollCert(
  baseUrl: string,
  sans: string[],
  deps: ProvisionHostTlsDeps,
  fetchFn: typeof fetch,
): Promise<string> {
  let response: Response;
  const jwt = await deps.getSigner();
  try {
    response = await agentFetch(
      `${baseUrl}/tls/enroll`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sans }),
        redirect: 'manual',
        signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS),
      },
      { caCertPem: deps.caCertPem ?? null },
      fetchFn,
    );
  } catch (err) {
    throw new Error(
      `TLS provisioning failed: the agent could not be reached to create its certificate (${err instanceof Error ? err.message : err}). ${RERUN_ADVICE}`,
    );
  }
  if (!response.ok) {
    const detail = await readErrorBody(response);
    throw new Error(
      `TLS provisioning failed: the agent rejected the certificate request (${detail}). ${RERUN_ADVICE}`,
    );
  }
  const body = (await response.json().catch(() => null)) as { certPem?: unknown } | null;
  if (typeof body?.certPem !== 'string' || !body.certPem.includes('BEGIN CERTIFICATE')) {
    throw new Error(`TLS provisioning failed: the agent returned no usable certificate. ${RERUN_ADVICE}`);
  }
  return body.certPem;
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
      `TLS provisioning failed: the agent could not be restarted (${err instanceof Error ? err.message : err}). ${RERUN_ADVICE}`,
    );
  }
  if (!response.ok) {
    const detail = await readErrorBody(response);
    throw new Error(
      `TLS provisioning failed: the agent could not be restarted to serve the new certificate (${detail}). ${RERUN_ADVICE}`,
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
      `TLS provisioning failed: ${reason} (${err instanceof Error ? err.message : err}). ${RERUN_ADVICE}`,
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

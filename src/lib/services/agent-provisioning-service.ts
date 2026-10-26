import type { TlsCertMaterial, TlsCertRequest } from '@/lib/services/agent-tls-cert-generator';

/**
 * Internal DNS name of the agent container inside the agent stack compose. The
 * agent-updater's post-update health check connects to https://hlm-agent:9090,
 * so the certificate must verify for it or every agent update rolls back.
 */
const INTERNAL_AGENT_DNS_NAME = 'hlm-agent';

const IP_LOOKUP_TIMEOUT_MS = 3000;

export interface HostTlsProvisionResult {
  /** https agent URL to store on the host record. */
  agentUrl: string;
  certPem: string;
  keyPem: string;
}

export interface AgentTlsProvisionDeps {
  generateCert: (request: TlsCertRequest) => Promise<TlsCertMaterial>;
  storeCert: (hostName: string, certPem: string, keyPem: string) => Promise<void>;
  /** Best-effort IP resolution for the SAN; null skips the IP entry. */
  resolveIp?: (hostname: string) => Promise<string | null>;
}

/**
 * Provisions the per-host TLS material at enrollment: self-signed certificate
 * covering the agent URL host (and its resolved IP when resolvable), stored in
 * the certificate repository, with the agent URL rewritten to https.
 */
export async function provisionHostTls(
  hostName: string,
  agentUrl: string,
  deps: AgentTlsProvisionDeps,
): Promise<HostTlsProvisionResult> {
  const parsed = new URL(agentUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Agent URL must use http or https, got '${parsed.protocol}'`);
  }
  const hostname = parsed.hostname;
  const ip = await resolveHostIp(hostname, deps.resolveIp ?? defaultResolveIp);
  const { certPem, keyPem } = await deps.generateCert({
    hostname,
    ip: ip ?? undefined,
    extraDnsNames: [INTERNAL_AGENT_DNS_NAME],
  });
  await deps.storeCert(hostName, certPem, keyPem);
  return { agentUrl: toHttpsAgentUrl(parsed), certPem, keyPem };
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

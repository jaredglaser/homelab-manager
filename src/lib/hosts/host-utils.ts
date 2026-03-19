import type { HostStatus } from '@/lib/database/repositories/host-repository';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';

/** Dockerode connection options parsed from a socket proxy URL. */
export interface DockerodeConfig {
  host: string;
  port: number;
  protocol: 'http' | 'https';
}

/** Parsed from the managed_hosts DB row for API responses. */
export interface HostListItem {
  id: number;
  name: string;
  agentUrl: string;
  socketProxyUrl: string;
  agentVersion: string | null;
  status: HostStatus;
  createdAt: string;
  updatedAt: string;
}

// Issue 13: Use Omit to derive from canonical ManagedHost, making the relationship explicit
// and ensuring toHostListItem cannot accidentally access token fields at the type level.
type ManagedHostPublic = Omit<ManagedHost, 'agent_token_hash' | 'agent_token'>;

export type HealthCheckOutcome =
  | { healthy: true; version?: string; dockerVersion?: string }
  | { healthy: false; error: string };

/** Map URL scheme to Dockerode protocol. tcp:// maps to http since Dockerode uses HTTP over TCP. */
function mapProtocol(scheme: string): 'http' | 'https' {
  if (scheme === 'https') return 'https';
  return 'http';
}

/**
 * Parse a socket proxy URL into Dockerode connection config.
 * Handles tcp://, http://, and https:// schemes.
 */
export function parseDockerodeConfig(socketProxyUrl: string): DockerodeConfig {
  const url = new URL(socketProxyUrl);
  return {
    host: url.hostname,
    port: Number(url.port) || 2375,
    protocol: mapProtocol(url.protocol.replace(':', '')),
  };
}

/**
 * Convert a managed_hosts DB row to an API-facing HostListItem.
 * Optional overrides allow setting status/version from health check results.
 * Accepts ManagedHostPublic (without credentials) to enforce the security boundary at the type level.
 */
export function toHostListItem(
  row: ManagedHostPublic,
  overrides?: { agentVersion?: string | null; status?: HostStatus },
): HostListItem {
  return {
    id: row.id,
    name: row.name,
    agentUrl: row.agent_url,
    socketProxyUrl: row.socket_proxy_url,
    agentVersion: overrides && 'agentVersion' in overrides ? overrides.agentVersion! : row.agent_version,
    status: overrides?.status ?? row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Retry a health check with exponential backoff delays.
 * Returns the first successful result, or the last failed result.
 * Logs each failed attempt for operational visibility.
 */
export async function retryHealthCheck(
  checkFn: (url: string) => Promise<HealthCheckOutcome>,
  agentUrl: string,
  delays: number[],
): Promise<HealthCheckOutcome> {
  let result: HealthCheckOutcome = { healthy: false, error: 'Health check not attempted' };
  for (let i = 0; i < delays.length; i++) {
    // Delay before each attempt (including the first) is intentional: the agent
    // container needs startup time before it can respond to health checks.
    await new Promise((resolve) => setTimeout(resolve, delays[i]));
    result = await checkFn(agentUrl);
    if (result.healthy) break;
    console.error(`[retryHealthCheck] Attempt ${i + 1}/${delays.length} failed for ${agentUrl}: ${result.error}`);
  }
  return result;
}

const AGENT_IMAGE_PROD = 'ghcr.io/homelab-manager/agent:latest';
const AGENT_IMAGE_DEV = 'homelab-manager-agent:dev';

/** Get the agent Docker image based on NODE_ENV. */
export function getAgentImage(): string {
  return process.env.NODE_ENV === 'development' ? AGENT_IMAGE_DEV : AGENT_IMAGE_PROD;
}

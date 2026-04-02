import type { HostStatus, HostCapabilities, ManagedHostRow } from '@/lib/database/repositories/host-repository';

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
  capabilities: HostCapabilities;
  agentVersion: string | null;
  status: HostStatus;
  createdAt: string;
  updatedAt: string;
}

export type HealthCheckOutcome =
  | { healthy: true; version?: string; dockerVersion?: string }
  | { healthy: false; error: string };

/**
 * Convert a managed_hosts DB row to an API-facing HostListItem.
 * Optional overrides allow setting status/version from health check results.
 */
export function toHostListItem(
  row: ManagedHostRow,
  overrides?: { agentVersion?: string | null; status?: HostStatus },
): HostListItem {
  return {
    id: row.id,
    name: row.name,
    agentUrl: row.agent_url,
    capabilities: row.capabilities ?? {},
    agentVersion: overrides && 'agentVersion' in overrides ? (overrides.agentVersion ?? null) : row.agent_version,
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
    console.info(`[retryHealthCheck] Attempt ${i + 1}/${delays.length} failed for ${agentUrl}: ${result.error}`);
  }
  return result;
}

const AGENT_IMAGE_PROD = 'ghcr.io/homelab-manager/agent:latest';
const AGENT_IMAGE_DEV = 'homelab-manager-agent:dev';

/** Get the agent Docker image based on NODE_ENV. */
export function getAgentImage(): string {
  return process.env.NODE_ENV === 'development' ? AGENT_IMAGE_DEV : AGENT_IMAGE_PROD;
}

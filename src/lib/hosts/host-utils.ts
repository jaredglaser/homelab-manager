import type { HostStatus, HostCapabilities, ManagedHost } from '@/lib/database/repositories/host-repository';

/** Dockerode connection options parsed from a socket proxy URL. */
export interface DockerodeConfig {
  host: string;
  port: number;
  protocol: 'http' | 'https';
}

/** Serialized ManagedHost for API responses (Date -> ISO string). */
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
  | { healthy: true; version?: string; dockerVersion?: string; infoSupported?: boolean }
  | { healthy: false; error: string };

/**
 * Convert a ManagedHost to an API-facing HostListItem (stringifies Date fields).
 * Optional overrides allow setting status/version from health check results.
 */
export function toHostListItem(
  row: ManagedHost,
  overrides?: { agentVersion?: string | null; status?: HostStatus },
): HostListItem {
  return {
    id: row.id,
    name: row.name,
    agentUrl: row.agentUrl,
    capabilities: row.capabilities ?? {},
    agentVersion: overrides && 'agentVersion' in overrides ? (overrides.agentVersion ?? null) : row.agentVersion,
    status: overrides?.status ?? row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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

export const HEALTH_CHECK_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 16000] as const;

const AGENT_IMAGE_PROD = 'ghcr.io/jaredglaser/homelab-manager-agent:latest';
// TODO: re-enable dev variant once CI publishes a :dev tag (or local compose tags
// the locally-built agent as :dev). Until then `:dev` resolves to nothing.
// const AGENT_IMAGE_DEV = 'homelab-manager-agent:dev';

/** Get the agent Docker image. */
export function getAgentImage(): string {
  // NOSONAR
  // return process.env.NODE_ENV === 'development' ? AGENT_IMAGE_DEV : AGENT_IMAGE_PROD;
  return AGENT_IMAGE_PROD;
}

const AGENT_UPDATER_IMAGE_PROD = 'ghcr.io/jaredglaser/homelab-manager-agent-updater:latest';
// TODO: re-enable dev variant once CI publishes a :dev tag (or local compose tags
// the locally-built agent-updater as :dev). Until then `:dev` resolves to nothing.
// const AGENT_UPDATER_IMAGE_DEV = 'homelab-manager-agent-updater:dev';

/** Get the agent-updater Docker image. */
export function getAgentUpdaterImage(): string {
  //NOSONAR
  // return process.env.NODE_ENV === 'development' ? AGENT_UPDATER_IMAGE_DEV : AGENT_UPDATER_IMAGE_PROD;
  return AGENT_UPDATER_IMAGE_PROD;
}

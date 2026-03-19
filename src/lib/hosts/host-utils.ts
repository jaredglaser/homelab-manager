import type { HostStatus } from '@/lib/database/repositories/host-repository';

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

/** DB row shape expected by toHostListItem. */
export interface ManagedHostRow {
  id: number;
  name: string;
  agent_url: string;
  socket_proxy_url: string;
  agent_version: string | null;
  status: HostStatus;
  created_at: Date;
  updated_at: Date;
}

/** Health check result from the agent. */
export interface HealthCheckOutcome {
  healthy: boolean;
  version?: string;
  dockerVersion?: string;
  error?: string;
}

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
 */
export function toHostListItem(
  row: ManagedHostRow,
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
 */
export async function retryHealthCheck(
  checkFn: (url: string) => Promise<HealthCheckOutcome>,
  agentUrl: string,
  delays: number[],
): Promise<HealthCheckOutcome> {
  let result: HealthCheckOutcome = { healthy: false, error: 'Health check not attempted' };
  for (const delayMs of delays) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await checkFn(agentUrl);
    if (result.healthy) break;
  }
  return result;
}

const AGENT_IMAGE_PROD = 'ghcr.io/homelab-manager/agent:latest';
const AGENT_IMAGE_DEV = 'homelab-manager-agent:dev';

/** Get the agent Docker image based on NODE_ENV. */
export function getAgentImage(): string {
  return process.env.NODE_ENV === 'development' ? AGENT_IMAGE_DEV : AGENT_IMAGE_PROD;
}

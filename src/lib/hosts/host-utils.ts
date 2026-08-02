import type { HostStatus, HostCapabilities, ManagedHost } from '@/lib/database/repositories/host-repository';

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

const AGENT_IMAGE_PROD = 'ghcr.io/jaredglaser/homelab-manager-agent:latest';

/** Get the agent Docker image. */
export function getAgentImage(): string {
  return AGENT_IMAGE_PROD;
}

const AGENT_UPDATER_IMAGE_PROD = 'ghcr.io/jaredglaser/homelab-manager-agent-updater:latest';

/** Get the agent-updater Docker image. */
export function getAgentUpdaterImage(): string {
  return AGENT_UPDATER_IMAGE_PROD;
}

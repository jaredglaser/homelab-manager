import type { HostStatus, HostCapabilities, ManagedHost } from '@/lib/database/repositories/host-repository';
import type { AgentHealthResult } from '@/lib/services/agent-health-service';

/** Serialized ManagedHost for API responses (Date -> ISO string). */
export interface HostListItem {
  id: number;
  name: string;
  agentUrl: string;
  capabilities: HostCapabilities;
  agentVersion: string | null;
  agentImage: string | null;
  agentImageTag: string | null;
  status: HostStatus;
  createdAt: string;
  updatedAt: string;
}

export type HealthCheckOutcome = AgentHealthResult;

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
    agentImage: row.agentImage,
    agentImageTag: row.agentImageTag,
    status: overrides?.status ?? row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const AGENT_IMAGE_REPO = 'ghcr.io/jaredglaser/homelab-manager-agent';
export const DEFAULT_AGENT_IMAGE_TAG = 'latest';

// Docker's tag grammar. The value lands unquoted in the generated agent .env, so a junk
// build arg must not reach the operator's host.
const DOCKER_TAG_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

/** Coerce a build-arg value to a usable tag, falling back to `latest` on anything malformed. */
export function normalizeAgentImageTag(raw: unknown): string {
  if (typeof raw !== 'string' || !DOCKER_TAG_PATTERN.test(raw)) return DEFAULT_AGENT_IMAGE_TAG;
  return raw;
}

/** Vite inlines this at build for the web, and the worker reads it from its own environment at runtime. */
export function getAgentImageTag(): string {
  return normalizeAgentImageTag(import.meta.env.VITE_AGENT_IMAGE_TAG);
}

export function getAgentImage(): string {
  return `${AGENT_IMAGE_REPO}:${getAgentImageTag()}`;
}

import type { HostCapabilities, ManagedHost } from '@/lib/database/repositories/host-repository';
import type { AgentHealthFailureReason } from '@/lib/services/agent-health-service';
import type { HealthCheckOutcome } from '@/lib/hosts/host-utils';

/**
 * Live reachability status for an agent:
 * - online: /health answered 200 with a valid agent body.
 * - offline: nothing answered at the network level (timeout, connection refused, DNS).
 * - unreachable: something answered HTTP but not a healthy agent (error status, redirect, non-JSON).
 * - unknown: the host is still 'pending' (never verified) and the probe failed.
 */
export type AgentInventoryStatus = 'online' | 'offline' | 'unreachable' | 'unknown';

export type AgentVersionSource = 'live' | 'stored' | 'unknown';

export interface AgentInventoryEntry {
  id: number;
  name: string;
  agentUrl: string;
  capabilities: HostCapabilities;
  status: AgentInventoryStatus;
  /** Live version from /info when online, otherwise the last stored version, otherwise null. */
  version: string | null;
  versionSource: AgentVersionSource;
  agentImage: string | null;
  agentImageTag: string | null;
  /** Probe error detail when status is not online, else null. */
  lastError: string | null;
  /** ISO timestamp of this inventory pass. */
  checkedAt: string;
}

export type AgentInventoryFailureReason = AgentHealthFailureReason;

function failureStatus(
  hostStatus: ManagedHost['status'],
  reason: AgentInventoryFailureReason | undefined,
): AgentInventoryStatus {
  if (hostStatus === 'pending') return 'unknown';
  return reason === 'unreachable' ? 'unreachable' : 'offline';
}

/**
 * Derive one inventory entry from a stored host row and its live health probe.
 * Version falls back to the stored value when the probe cannot report one, so a
 * briefly offline agent still shows its last known version.
 */
export function buildAgentInventoryEntry(
  host: ManagedHost,
  outcome: HealthCheckOutcome,
  checkedAt: Date = new Date(),
): AgentInventoryEntry {
  if (outcome.healthy) {
    return {
      id: host.id,
      name: host.name,
      agentUrl: host.agentUrl,
      capabilities: host.capabilities ?? {},
      status: 'online',
      version: outcome.version ?? host.agentVersion ?? null,
      versionSource: outcome.version ? 'live' : host.agentVersion ? 'stored' : 'unknown',
      agentImage: host.agentImage,
      agentImageTag: host.agentImageTag,
      lastError: null,
      checkedAt: checkedAt.toISOString(),
    };
  }

  return {
    id: host.id,
    name: host.name,
    agentUrl: host.agentUrl,
    capabilities: host.capabilities ?? {},
    status: failureStatus(host.status, outcome.reason),
    version: host.agentVersion ?? null,
    versionSource: host.agentVersion ? 'stored' : 'unknown',
    agentImage: host.agentImage,
    agentImageTag: host.agentImageTag,
    lastError: outcome.error,
    checkedAt: checkedAt.toISOString(),
  };
}
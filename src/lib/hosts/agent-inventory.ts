import type { HostCapabilities, ManagedHost } from '@/lib/database/repositories/host-repository';
import type { AgentHealthFailureReason } from '@/lib/services/agent-health-service';
import type { HostProbeFailureCode } from '@/lib/errors/host-failure-copy';
import type { HealthCheckOutcome } from '@/lib/hosts/host-utils';

/**
 * Every reachability status an agent can be reported as. The runtime list is the source of truth for
 * the wire schema, which has to accept all of them or the client drops the whole snapshot.
 */
export const AGENT_INVENTORY_STATUSES = [
  'online',
  'offline',
  'unreachable',
  'awaiting-enrollment',
  'unknown',
] as const;

/**
 * Live reachability status for an agent:
 * - online: /health answered 200 with a valid agent body.
 * - offline: nothing answered at the network level (timeout, connection refused, DNS).
 * - unreachable: something answered HTTP but not a healthy agent (error status, redirect, non-JSON).
 * - awaiting-enrollment: the agent serves plain HTTP because it holds no certificate yet.
 * - unknown: the host is still 'pending' (never verified) and the probe failed.
 */
export type AgentInventoryStatus = (typeof AGENT_INVENTORY_STATUSES)[number];

export type AgentVersionSource = 'live' | 'stored' | 'unknown';

/** Why an agent is not online, in the coded form the card turns into copy. */
export interface AgentInventoryFailure {
  /** A code the shared host-failure copy is keyed by. */
  code: HostProbeFailureCode;
  /** The probe's own detail, or an empty string when it named none. */
  message: string;
}

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
  /** Digest of the image the agent container runs, from the agent's /info. Null when unknown. */
  agentImageDigest: string | null;
  /** True when the last sweep found the running digest different from the manager's own agent image. */
  agentOutOfDate: boolean;
  /** Why the last probe failed when status is not online, else null. */
  failure: AgentInventoryFailure | null;
  /** ISO timestamp of the inventory pass that produced this entry. */
  checkedAt: string;
}

export type AgentInventoryFailureReason = AgentHealthFailureReason;

/** pg NOTIFY channel the worker fires after each inventory sweep; the server's broadcast service LISTENs on it. */
export const AGENT_INVENTORY_NOTIFY_CHANNEL = 'agent_inventory_change';

export interface AgentInventorySnapshot {
  entries: AgentInventoryEntry[];
  /** ISO timestamp of the most recent sweep reflected in these entries, null when no host has ever been swept. */
  sweptAt: string | null;
}

function failureStatus(
  hostStatus: ManagedHost['status'],
  reason: AgentInventoryFailureReason | undefined,
): AgentInventoryStatus {
  if (hostStatus === 'pending') return 'unknown';
  if (reason === 'awaiting-enrollment') return 'awaiting-enrollment';
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
  agentOutOfDate = false,
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
      // Same-sweep consistency: the verdict is computed from the fresh outcome, so the digest it is
      // paired with must come from the same probe, not from the previous sweep's stored row.
      agentImageDigest: outcome.agentImageDigest ?? null,
      agentOutOfDate,
      failure: null,
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
    agentImageDigest: host.agentImageDigest,
    agentOutOfDate: host.agentOutOfDate,
    failure: { code: outcome.reason ?? 'health_check_failed', message: outcome.error },
    checkedAt: checkedAt.toISOString(),
  };
}

/**
 * Derive one inventory entry from a stored host row alone, no probe. The sweep
 * persists status/agent info into managed_hosts, so the stored row already
 * reflects the last sweep; updatedAt doubles as the per-host checkedAt.
 */
export function buildStoredAgentInventoryEntry(host: ManagedHost): AgentInventoryEntry {
  return {
    id: host.id,
    name: host.name,
    agentUrl: host.agentUrl,
    capabilities: host.capabilities ?? {},
    status: storedStatus(host),
    version: host.agentVersion ?? null,
    versionSource: host.agentVersion ? 'stored' : 'unknown',
    agentImage: host.agentImage,
    agentImageTag: host.agentImageTag,
    agentImageDigest: host.agentImageDigest,
    agentOutOfDate: host.agentOutOfDate,
    failure:
      host.failureCode === null
        ? null
        : { code: host.failureCode, message: host.failureDetail ?? '' },
    // Not updatedAt: every writer to managed_hosts bumps that column (rename,
    // URL edit, key rotation, a single-host health check), so it reports a
    // fresher sweep than actually ran. A host created but not yet swept falls
    // back to updatedAt, which is then its creation time.
    checkedAt: (host.lastSweptAt ?? host.updatedAt).toISOString(),
  };
}

/**
 * Reachability of a stored host. The recorded cause wins when there is one, so
 * an agent that answered as something other than a healthy agent, or that is
 * waiting on a certificate, is reported as that rather than as generically down.
 * A host with no recorded cause has only its status column to go on.
 */
function storedStatus(host: ManagedHost): AgentInventoryStatus {
  if (host.failureCode === 'awaiting-enrollment') return 'awaiting-enrollment';
  if (host.failureCode === 'unreachable') return 'unreachable';
  if (host.failureCode !== null) return 'offline';
  if (host.status === 'healthy') return 'online';
  if (host.status === 'pending') return 'unknown';
  if (host.status === 'error') return 'unreachable';
  return 'offline';
}

/** Read-only snapshot of every host from stored rows, plus the sweep time implied by the freshest lastSweptAt. */
export function buildAgentInventorySnapshot(hosts: ManagedHost[]): AgentInventorySnapshot {
  const sweptAt = hosts.reduce<Date | null>((max, host) => {
    const at = host.lastSweptAt;
    if (at === null) return max;
    return max === null || at > max ? at : max;
  }, null);

  return {
    entries: hosts.map(buildStoredAgentInventoryEntry),
    sweptAt: sweptAt ? sweptAt.toISOString() : null,
  };
}

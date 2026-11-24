import type { HostCapabilities, ManagedHost } from '@/lib/database/repositories/host-repository';
import type { HostProbeFailureCode } from '@/lib/errors/host-failure-copy';

/** The wire schema reads its members from this list: a status it rejects drops the client's whole snapshot. */
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
 * - unknown: the host is still 'pending' (never verified) and no probe has named a cause.
 */
export type AgentInventoryStatus = (typeof AGENT_INVENTORY_STATUSES)[number];

export interface AgentInventoryFailure {
  code: HostProbeFailureCode;
  /** Empty when the probe named no detail. */
  message: string;
}

export interface AgentInventoryEntry {
  id: number;
  name: string;
  agentUrl: string;
  capabilities: HostCapabilities;
  status: AgentInventoryStatus;
  /** Last version the agent reported, null when it never reported one. */
  version: string | null;
  agentImage: string | null;
  agentImageTag: string | null;
  /** Digest of the image the agent container runs, from the agent's /info. Null when unknown. */
  agentImageDigest: string | null;
  /** True when the last sweep found the running digest different from the manager's own agent image. */
  agentOutOfDate: boolean;
  failure: AgentInventoryFailure | null;
  /** ISO timestamp of the inventory pass that produced this entry. */
  checkedAt: string;
}

/** pg NOTIFY channel the worker fires after each inventory sweep; the server's broadcast service LISTENs on it. */
export const AGENT_INVENTORY_NOTIFY_CHANNEL = 'agent_inventory_change';

export interface AgentInventorySnapshot {
  entries: AgentInventoryEntry[];
  /** ISO timestamp of the most recent sweep reflected in these entries, null when no host has ever been swept. */
  sweptAt: string | null;
}

const FAILURE_STATUS: Record<HostProbeFailureCode, AgentInventoryStatus> = {
  offline: 'offline',
  unreachable: 'unreachable',
  'awaiting-enrollment': 'awaiting-enrollment',
  'agent-unhealthy': 'unreachable',
  'certificate-rejected': 'unreachable',
  health_check_failed: 'offline',
};

function inventoryStatus(host: ManagedHost, failure: HostProbeFailureCode | null): AgentInventoryStatus {
  if (failure !== null) return FAILURE_STATUS[failure];
  if (host.status === 'pending') return 'unknown';
  return host.status === 'healthy' ? 'online' : host.status === 'error' ? 'unreachable' : 'offline';
}

/**
 * Derive one inventory entry from a stored host row alone, no probe. The sweep
 * persists status/agent info into managed_hosts, so the stored row already
 * reflects the last sweep. Its lastSweptAt doubles as the per-host checkedAt.
 */
export function buildStoredAgentInventoryEntry(host: ManagedHost): AgentInventoryEntry {
  return {
    id: host.id,
    name: host.name,
    agentUrl: host.agentUrl,
    capabilities: host.capabilities ?? {},
    status: inventoryStatus(host, host.failure?.code ?? null),
    version: host.agentVersion ?? null,
    agentImage: host.agentImage,
    agentImageTag: host.agentImageTag,
    agentImageDigest: host.agentImageDigest,
    agentOutOfDate: host.agentOutOfDate,
    failure: host.failure === null ? null : { code: host.failure.code, message: host.failure.detail ?? '' },
    // Not updatedAt: every writer to managed_hosts bumps that column (rename,
    // URL edit, key rotation, a single-host health check), so it reports a
    // fresher sweep than actually ran. A host created but not yet swept falls
    // back to updatedAt, which is then its creation time.
    checkedAt: (host.lastSweptAt ?? host.updatedAt).toISOString(),
  };
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

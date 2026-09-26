import type { ManagedHost, HostStatus } from '@/lib/database/repositories/host-repository';
import { toHostListItem } from '@/lib/hosts/host-utils';
import type { HostListItem, HealthCheckOutcome } from '@/lib/hosts/host-utils';
import { buildAgentInventoryEntry } from '@/lib/hosts/agent-inventory';
import type { AgentInventoryEntry } from '@/lib/hosts/agent-inventory';

export type { HostListItem } from '@/lib/hosts/host-utils';
export type { AgentInventoryEntry, AgentInventoryStatus, AgentVersionSource } from '@/lib/hosts/agent-inventory';

export interface KeypairsDep {
  createForHost: (hostName: string) => Promise<{ publicJwk: import('jose').JWK }>;
  deleteForHost: (hostName: string) => Promise<void>;
}

export interface AddHostResult {
  host: HostListItem;
  publicJwk?: import('jose').JWK;
}

export type HostOperationResult =
  | {
      hostId: number;
      healthy: true;
      version?: string;
      dockerVersion?: string;
      agentImage?: string | null;
      agentImageTag?: string | null;
    }
  | { hostId: number; healthy: false; error: string; suggestions?: string[] };

export type HealthCheckResult = HostOperationResult;
export type UpdateAgentResult = HostOperationResult;

/** Poll cadence while waiting for a restarted agent to report a new version. */
const HEALTH_CHECK_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 16000] as const;

/** Result of pushing the auto-update policy to the agent on the host. */
export interface PolicyPropagation {
  applied: boolean;
  warning?: string;
}

export interface SetAgentAutoUpdateResult {
  host: HostListItem;
  propagation: PolicyPropagation;
}

export interface HostRepo {
  findById(id: number): Promise<ManagedHost | null>;
  findAll(): Promise<ManagedHost[]>;
  create(input: { name: string; agentUrl: string; capabilities?: { docker?: boolean; zfs?: boolean } }): Promise<ManagedHost>;
  delete(id: number): Promise<void>;
  updateStatus(id: number, status: HostStatus): Promise<void>;
  updateAgentInfo(id: number, fields: { version?: string; image?: string | null; imageTag?: string | null }): Promise<void>;
  updateAutoUpdate(id: number, enabled: boolean): Promise<void>;
  update(id: number, fields: { name?: string; agentUrl?: string; capabilities?: { docker?: boolean; zfs?: boolean } }): Promise<ManagedHost>;
}

export interface HostHandlerDeps {
  repo: HostRepo;
}

export async function handleListHosts(deps: HostHandlerDeps): Promise<HostListItem[]> {

  const hosts = await deps.repo.findAll();
  return hosts.map((h) => toHostListItem(h));
}

export async function handleCheckHostHealth(
  deps: HostHandlerDeps & { checkHealth: (url: string, hostName: string) => Promise<HealthCheckOutcome> },
  data: { hostId: number },
): Promise<HostOperationResult> {


  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  const healthResult = await deps.checkHealth(host.agentUrl, host.name);
  const newStatus: HostStatus = healthResult.healthy ? 'healthy' : 'unhealthy';
  await deps.repo.updateStatus(host.id, newStatus);

  if (healthResult.healthy && (healthResult.version || healthResult.infoSupported)) {
    // Only an agent that answered /info may clear its image; a 404 leaves the stored value.
    await deps.repo.updateAgentInfo(host.id, {
      version: healthResult.version,
      ...(healthResult.infoSupported
        ? { image: healthResult.agentImage ?? null, imageTag: healthResult.agentImageTag ?? null }
        : {}),
    });
  }

  return healthResult.healthy
    ? {
        hostId: host.id,
        healthy: true,
        version: healthResult.version,
        dockerVersion: healthResult.dockerVersion,
        agentImage: healthResult.agentImage,
        agentImageTag: healthResult.agentImageTag,
      }
    : { hostId: host.id, healthy: false, error: healthResult.error };
}

export async function handleRemoveHost(
  deps: HostHandlerDeps & { keypairs: Pick<KeypairsDep, 'deleteForHost'> },
  data: { hostId: number },
): Promise<{ success: boolean }> {
  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  try {
    await deps.keypairs.deleteForHost(host.name);
  } catch (err) {
    console.error(`[removeHost] Failed to delete agent keypair for ${host.name}:`, err instanceof Error ? err.message : err);
  }

  await deps.repo.delete(data.hostId);
  return { success: true };
}

export async function handleUpdateHost(
  deps: HostHandlerDeps,
  data: { hostId: number; name?: string; agentUrl?: string },
): Promise<HostListItem> {
  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  // The host name is the cryptographic identity: it is the agent_keypairs lookup
  // key, the JWT `aud`, and the agent container's AGENT_HOST_NAME. Changing it
  // here would orphan the keypair and mint tokens the running agent rejects, so
  // the name is immutable. Renaming means remove-and-re-add, which also requires
  // updating AGENT_HOST_NAME on the agent and restarting it.
  if (data.name !== undefined && data.name.trim() !== host.name) {
    throw new Error('Host name cannot be changed after enrollment. To rename, remove and re-add the host.');
  }

  const fields: { agentUrl?: string } = {};
  if (data.agentUrl !== undefined) fields.agentUrl = data.agentUrl;

  const updated = await deps.repo.update(data.hostId, fields);
  return toHostListItem(updated);
}

/**
 * Register a user-managed agent. Generates an Ed25519 keypair and returns the
 * public JWK to the operator, who installs it in the agent's AGENT_TRUSTED_PUBKEY
 * env. Status is pending until the operator installs the pubkey and a follow-up
 * health check passes.
 */
export async function handleVerifyHost(
  deps: HostHandlerDeps & { keypairs: KeypairsDep },
  data: { name: string; agentUrl: string; capabilities?: { docker?: boolean; zfs?: boolean } },
): Promise<AddHostResult> {
  const name = data.name.trim();
  const host = await deps.repo.create({
    name,
    agentUrl: data.agentUrl,
    capabilities: data.capabilities,
  });

  let publicJwk;
  try {
    ({ publicJwk } = await deps.keypairs.createForHost(name));
  } catch (err) {
    await deps.repo.delete(host.id);
    throw new Error(`Failed to generate agent keypair: ${err instanceof Error ? err.message : err}. Host record cleaned up.`);
  }

  return {
    host: toHostListItem(host, { agentVersion: null, status: 'pending' }),
    publicJwk,
  };
}

/**
 * Trigger a manual update for exactly ONE agent, addressed by its host id.
 * Never touches any other host: the update request is scoped to
 * host.agentUrl and the agent-updater sidecar on that host watches only that
 * host's agent container.
 *
 * Flow: record the current version, relay the trigger through the agent to
 * its agent-updater sidecar, then poll the agent's health/version until a
 * version change confirms the update. The sidecar answers "no update
 * available" without restarting the agent, which surfaces as a distinct
 * result rather than a failure.
 */
export async function handleUpdateAgent(
  deps: HostHandlerDeps & {
    getSigner: (hostname: string) => Promise<() => Promise<string>>;
    checkHealth: (url: string, hostName: string) => Promise<HealthCheckOutcome>;
  },
  data: { hostId: number },
): Promise<HostOperationResult> {
  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  // 1. Record current version before update
  const preCheck = await deps.checkHealth(host.agentUrl, host.name);
  if (!preCheck.healthy) {
    return {
      hostId: host.id,
      healthy: false,
      error: 'Agent is unreachable before update',
      suggestions: [
        'Check that the agent container is running',
        'Run `docker logs hlm-agent` to inspect agent startup errors',
      ],
    };
  }
  const currentVersion = preCheck.version;
  // A missing pre-update version only implies an upgrade when /info 404s; any
  // other cause would make a later version read look like a change that never happened.
  const preInfoUnsupported = preCheck.infoSupported === false;

  // 2. Retrieve signer and mint a JWT for the request
  let signer: () => Promise<string>;
  try {
    signer = await deps.getSigner(host.name);
  } catch {
    return {
      hostId: host.id,
      healthy: false,
      error: 'Could not retrieve agent keypair',
      suggestions: [
        'Check that the master key is configured (MASTER_KEY env var)',
        'Verify the agent has been enrolled with a generated public JWK',
      ],
    };
  }

  const jwt = await signer();

  // 3. Trigger the update on this agent only
  let triggerResponse: Response;
  try {
    const agentBaseUrl = host.agentUrl.replace(/\/+$/, '');
    triggerResponse = await fetch(`${agentBaseUrl}/agent/update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      redirect: 'manual',
    });
  } catch (err) {
    return {
      hostId: host.id,
      healthy: false,
      error: err instanceof Error ? err.message : String(err),
      suggestions: [
        'Check that the agent is reachable at its configured URL',
        'Run `docker logs hlm-agent` to inspect agent errors',
        'Verify that Docker capability is enabled for this host',
      ],
    };
  }

  if (triggerResponse.type === 'opaqueredirect' || (triggerResponse.status >= 300 && triggerResponse.status < 400)) {
    return {
      hostId: host.id,
      healthy: false,
      error: 'Agent URL returned an unexpected redirect',
      suggestions: [
        'Check that the agent is reachable at its configured URL',
        'Run `docker logs hlm-agent` to inspect agent errors',
        'Verify that Docker capability is enabled for this host',
      ],
    };
  }

  if (triggerResponse.status === 200) {
    // The agent-updater checked the registry and found nothing newer.
    return { hostId: host.id, healthy: true };
  }

  if (triggerResponse.status !== 202) {
    const body = await triggerResponse.text().catch(() => '');
    // The updater answers with JSON like {"error":"..."}; surface the message,
    // not the raw body.
    let error = body || `Unexpected status ${triggerResponse.status} from agent update endpoint`;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed?.error === 'string') error = parsed.error;
    } catch {
      // Body was not JSON; keep the raw text.
    }
    return {
      hostId: host.id,
      healthy: false,
      error,
      suggestions: [
        'Check that the agent is reachable at its configured URL',
        'Verify the agent stack includes the agent-updater container',
        'Verify that Docker capability is enabled for this host',
      ],
    };
  }

  // 4. Poll for version change
  let lastResult: HealthCheckOutcome = { healthy: false, error: 'Health check not attempted' };
  let newVersion: string | undefined;

  for (const delay of HEALTH_CHECK_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    lastResult = await deps.checkHealth(host.agentUrl, host.name);
    if (!lastResult.healthy || lastResult.version === undefined) continue;
    if (preInfoUnsupported || (currentVersion !== undefined && lastResult.version !== currentVersion)) {
      newVersion = lastResult.version;
      break;
    }
  }

  if (!newVersion) {
    if (lastResult.healthy && currentVersion !== undefined && lastResult.version === currentVersion) {
      return {
        hostId: host.id,
        healthy: false,
        error: 'Agent appears to be on the latest version already',
        suggestions: [
          'Verify the image registry has a newer build',
          'Check that the current version matches your expectations',
        ],
      };
    }
    if (lastResult.healthy) {
      return {
        hostId: host.id,
        healthy: false,
        error: 'Agent is reachable but its version could not be read, so the update could not be confirmed',
        suggestions: [
          'Run `docker logs hlm-agent` to check which image the agent is running',
          'Verify the agent has been enrolled with a generated public JWK',
          'Re-run the health check once the agent settles to refresh its reported version',
        ],
      };
    }
    return {
      hostId: host.id,
      healthy: false,
      error: 'Agent did not restart after update',
      suggestions: [
        'Run `docker ps -a | grep hlm-agent` to check container state',
        'Run `docker logs hlm-agent-updater` for pull or start errors',
        'Check available disk space for the image pull',
      ],
    };
  }

  // 5. Success
  await deps.repo.updateStatus(host.id, 'healthy');
  await deps.repo.updateAgentInfo(host.id, { version: newVersion });
  return { hostId: host.id, healthy: true, version: newVersion };
}

/**
 * Persist the per-agent auto-update opt-in, then best-effort push the policy
 * to the running agent so its agent-updater sidecar picks it up without a
 * manual redeploy. The DB row is the source of truth; propagation failure
 * never rolls the setting back, it is reported as a warning instead.
 */
export async function handleSetAgentAutoUpdate(
  deps: HostHandlerDeps & {
    propagatePolicy?: (host: ManagedHost, enabled: boolean) => Promise<PolicyPropagation>;
  },
  data: { hostId: number; autoUpdate: boolean },
): Promise<SetAgentAutoUpdateResult> {
  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  await deps.repo.updateAutoUpdate(host.id, data.autoUpdate);

  let propagation: PolicyPropagation;
  if (!deps.propagatePolicy) {
    propagation = { applied: false, warning: 'Policy propagation is not available in this deployment.' };
  } else if (!host.capabilities.docker) {
    propagation = {
      applied: false,
      warning: 'Host has no Docker capability, so there is no agent-updater to reconfigure. The setting is stored and applies when the host gains Docker capability.',
    };
  } else {
    propagation = await deps.propagatePolicy(host, data.autoUpdate);
  }

  const updated = await deps.repo.findById(host.id);
  return { host: toHostListItem(updated ?? host), propagation };
}

export interface AgentsInventoryDeps extends HostHandlerDeps {
  checkHealth: (url: string, hostName: string) => Promise<HealthCheckOutcome>;
}

/**
 * Inventory of every registered agent with a live probe per host. Unreachable
 * hosts stay in the list with an offline/unreachable/unknown status. Each probe
 * persists healthy/unhealthy and reported agent info like handleCheckHostHealth,
 * except a pending host stays pending on failure: pending means enrollment was
 * never confirmed, which is not the same as an agent that went down.
 */
export async function handleListAgentsInventory(
  deps: AgentsInventoryDeps,
  now: Date = new Date(),
): Promise<AgentInventoryEntry[]> {
  const hosts = await deps.repo.findAll();
  const outcomes = await Promise.all(
    hosts.map(async (host): Promise<HealthCheckOutcome> => {
      try {
        return await deps.checkHealth(host.agentUrl, host.name);
      } catch (err) {
        return {
          healthy: false,
          reason: 'offline' as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  await Promise.all(
    hosts.map(async (host, i) => {
      const outcome = outcomes[i];
      if (!outcome) return;
      if (host.status === 'pending' && !outcome.healthy) return;
      await deps.repo.updateStatus(host.id, outcome.healthy ? 'healthy' : 'unhealthy');
      if (outcome.healthy && (outcome.version || outcome.infoSupported)) {
        await deps.repo.updateAgentInfo(host.id, {
          version: outcome.version,
          ...(outcome.infoSupported
            ? { image: outcome.agentImage ?? null, imageTag: outcome.agentImageTag ?? null }
            : {}),
        });
      }
    }),
  );

  return hosts.map((host, i) => buildAgentInventoryEntry(host, outcomes[i], now));
}

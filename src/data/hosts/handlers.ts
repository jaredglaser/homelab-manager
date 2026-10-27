import type { ManagedHost, HostStatus } from '@/lib/database/repositories/host-repository';
import { toHostListItem, getAgentImage } from '@/lib/hosts/host-utils';
import type { HostListItem, HealthCheckOutcome } from '@/lib/hosts/host-utils';
import { resolveAgentImageDigest } from '@/lib/hosts/agent-image-digest';
import { agentFetch } from '@/lib/clients/agent-http';
import { buildAgentInventoryEntry, buildStoredAgentInventoryEntry } from '@/lib/hosts/agent-inventory';
import type { AgentInventoryEntry } from '@/lib/hosts/agent-inventory';

export type { HostListItem } from '@/lib/hosts/host-utils';
export type { AgentInventoryEntry, AgentInventoryStatus, AgentVersionSource } from '@/lib/hosts/agent-inventory';

export interface KeypairsDep {
  createForHost: (hostName: string) => Promise<{ publicJwk: import('jose').JWK }>;
  deleteForHost: (hostName: string) => Promise<void>;
  getPublicJwkForHost: (hostName: string) => Promise<import('jose').JWK | null>;
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

const HEALTH_CHECK_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 16000] as const;

function digestPinnedImageRef(imageRef: string, digest: string): string {
  return `${imageRef.slice(0, imageRef.lastIndexOf(':'))}@${digest}`;
}

export interface HostRepo {
  findById(id: number): Promise<ManagedHost | null>;
  findAll(): Promise<ManagedHost[]>;
  create(input: { name: string; agentUrl: string; capabilities?: { docker?: boolean; zfs?: boolean } }): Promise<ManagedHost>;
  findByName(name: string): Promise<ManagedHost | null>;
  delete(id: number): Promise<void>;
  updateStatus(id: number, status: HostStatus): Promise<void>;
  updateLastSweptAt(id: number, at: Date): Promise<void>;
  updateAgentInfo(id: number, fields: { version?: string; image?: string | null; imageTag?: string | null; imageDigest?: string | null; outOfDate?: boolean }): Promise<void>;
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

export async function handleGetHostPublicJwk(
  deps: HostHandlerDeps & { keypairs: KeypairsDep },
  data: { hostId: number },
): Promise<{ publicJwk: import('jose').JWK }> {
  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  const publicJwk = await deps.keypairs.getPublicJwkForHost(host.name);
  if (!publicJwk) {
    throw new Error(`No agent keypair found for host ${host.name}`);
  }
  return { publicJwk };
}

export async function handleRotateHostKeypair(
  deps: HostHandlerDeps & { keypairs: KeypairsDep },
  data: { hostId: number },
): Promise<{ hostId: number; publicJwk: import('jose').JWK }> {
  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  const { publicJwk } = await deps.keypairs.createForHost(host.name);
  return { hostId: host.id, publicJwk };
}

/**
 * Register a user-managed agent. Generates an Ed25519 keypair and returns the
 * public JWK to the operator, who installs it in the agent's AGENT_TRUSTED_PUBKEY
 * env. Status is pending until the operator installs the pubkey and a follow-up
 * health check passes.
 */
export async function handleVerifyHost(
  deps: HostHandlerDeps & {
    keypairs: KeypairsDep;
    /** Must run after repo.create: the cert row has an FK on the host name. Flips the agent URL to https on success. */
    provisionTls?: (hostName: string, agentUrl: string) => Promise<{ agentUrl: string }>;
  },
  data: { name: string; agentUrl: string; capabilities?: { docker?: boolean; zfs?: boolean } },
): Promise<AddHostResult> {
  const name = data.name.trim();
  // The wizard re-runs verifyHost after a failed attempt, and the pending row
  // from that attempt blocks a second create on the unique host name.
  const existing = await deps.repo.findByName(name);
  const host = existing ?? (await deps.repo.create({
    name,
    agentUrl: data.agentUrl,
    capabilities: data.capabilities,
  }));

  let publicJwk;
  try {
    ({ publicJwk } = await deps.keypairs.createForHost(name));
  } catch (err) {
    if (!existing) await deps.repo.delete(host.id);
    throw new Error(`Failed to generate agent keypair: ${err instanceof Error ? err.message : err}${existing ? '' : '. Host record cleaned up.'}`);
  }

  if (deps.provisionTls) {
    let provisioned: { agentUrl: string };
    try {
      provisioned = await deps.provisionTls(name, data.agentUrl);
    } catch (err) {
      // The host stays pending so the operator can fix the agent and re-run
      // provisioning instead of losing the enrolled keypair with the record.
      throw new Error(err instanceof Error ? err.message : String(err));
    }
    const updated = await deps.repo.update(host.id, { agentUrl: provisioned.agentUrl });
    return {
      host: toHostListItem(updated, { agentVersion: null, status: 'pending' }),
      publicJwk,
    };
  }

  return {
    host: toHostListItem(host, { agentVersion: null, status: 'pending' }),
    publicJwk,
  };
}

/** Re-runs TLS provisioning for an enrolled host. Failure leaves the host record and its enrolled keypair untouched. */
export async function handleRotateHostTls(
  deps: HostHandlerDeps & {
    provisionTls: (hostName: string, agentUrl: string) => Promise<{ agentUrl: string }>;
  },
  data: { hostId: number },
): Promise<{ hostId: number; agentUrl: string }> {
  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  const provisioned = await deps.provisionTls(host.name, host.agentUrl);
  await deps.repo.update(host.id, { agentUrl: provisioned.agentUrl });
  return { hostId: host.id, agentUrl: provisioned.agentUrl };
}

// Scoped to this host's agentUrl. Never touches any other host.
export async function handleUpdateAgent(
  deps: HostHandlerDeps & {
    getSigner: (hostname: string) => Promise<() => Promise<string>>;
    checkHealth: (url: string, hostName: string) => Promise<HealthCheckOutcome>;
    resolveAgentImageDigest?: (imageRef: string) => Promise<string | null>;
    /** Pinned TLS certificate lookup. Without it, https agent URLs refuse to connect. */
    getCaCert?: (hostname: string) => Promise<string | null>;
  },
  data: { hostId: number },
): Promise<HostOperationResult> {
  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

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
  // A missing pre-update version only implies an upgrade when /info 404s. Any
  // other cause would make a later version read look like a change that never happened.
  const preInfoUnsupported = preCheck.infoSupported === false;

  const resolveDigest = deps.resolveAgentImageDigest ?? resolveAgentImageDigest;
  const imageRef = getAgentImage();
  const digest = await resolveDigest(imageRef);
  if (!digest) {
    return {
      hostId: host.id,
      healthy: false,
      error: 'Could not resolve the agent image digest from the registry',
      suggestions: [
        'Verify ghcr.io/jaredglaser/homelab-manager-agent is reachable and public',
        'Check the VITE_AGENT_IMAGE_TAG the dashboard was built with',
      ],
    };
  }
  const targetImage = digestPinnedImageRef(imageRef, digest);

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

  let jwt: string;
  try {
    jwt = await signer();
  } catch {
    return {
      hostId: host.id,
      healthy: false,
      error: 'Could not sign the agent request token',
      suggestions: [
        'Check that the master key is configured (MASTER_KEY env var)',
        'Verify the agent has been enrolled with a generated public JWK',
      ],
    };
  }

  let triggerResponse: Response;
  try {
    const agentBaseUrl = host.agentUrl.replace(/\/+$/, '');
    triggerResponse = await agentFetch(`${agentBaseUrl}/agent/update`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetImage }),
      redirect: 'manual',
    }, { caCertPem: deps.getCaCert ? await deps.getCaCert(host.name) : null });
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
    // The agent checked its own image and found nothing newer.
    return { hostId: host.id, healthy: true };
  }

  if (triggerResponse.status !== 202) {
    const body = await triggerResponse.text().catch(() => '');
    // The agent answers with JSON like {"error":"..."}; surface the message,
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
        'Verify that Docker capability is enabled for this host',
      ],
    };
  }

  let lastResult: HealthCheckOutcome = { healthy: false, error: 'Health check not attempted' };
  let newVersion: string | undefined;
  // The helper pulls the new image before stopping the old agent, so on an /info-less host a
  // healthy poll alone proves nothing. A restart is only evidenced by an observed failed poll.
  let sawRestart = false;

  for (const delay of HEALTH_CHECK_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    lastResult = await deps.checkHealth(host.agentUrl, host.name);
    if (!lastResult.healthy) {
      sawRestart = true;
      continue;
    }
    if (lastResult.version === undefined) continue;
    if (preInfoUnsupported) {
      if (sawRestart) {
        newVersion = lastResult.version;
        break;
      }
      continue;
    }
    if (currentVersion !== undefined && lastResult.version !== currentVersion) {
      newVersion = lastResult.version;
      break;
    }
  }

  if (!newVersion) {
    if (lastResult.healthy && currentVersion !== undefined && lastResult.version === currentVersion) {
      // An image rebuilt without a version bump keeps the version string, so the digest is what proves the swap happened.
      if (typeof lastResult.agentImageDigest === 'string') {
        if (lastResult.agentImageDigest !== digest) {
          return {
            hostId: host.id,
            healthy: false,
            error: 'The agent is still running its previous image, so the update was interrupted before it completed',
            suggestions: [
              'Check free disk space on the host, then retry the update',
              'Run `docker ps -a | grep hlm-agent` to check container state',
            ],
          };
        }
        await deps.repo.updateStatus(host.id, 'healthy');
        await deps.repo.updateAgentInfo(host.id, { imageDigest: digest, outOfDate: false });
        return { hostId: host.id, healthy: true };
      }
      return { hostId: host.id, healthy: true };
    }
    if (lastResult.healthy && preInfoUnsupported && !sawRestart) {
      return {
        hostId: host.id,
        healthy: false,
        error: 'The agent stayed reachable throughout the update window, so its restart could not be confirmed',
        suggestions: [
          'Re-run the update after the current attempt settles',
          'Run `docker ps -a | grep hlm-agent` to check container state',
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
        'Check available disk space for the image pull',
      ],
    };
  }

  await deps.repo.updateStatus(host.id, 'healthy');
  await deps.repo.updateAgentInfo(host.id, { version: newVersion, imageDigest: digest, outOfDate: false });
  return { hostId: host.id, healthy: true, version: newVersion };
}

export interface AgentsInventoryDeps extends HostHandlerDeps {
  checkHealth: (url: string, hostName: string) => Promise<HealthCheckOutcome>;
  resolveAgentImageDigest?: (imageRef: string) => Promise<string | null>;
}

function agentOutOfDateFor(outcome: HealthCheckOutcome | undefined, expected: string | null): boolean {
  return !!(
    outcome?.healthy &&
    outcome.agentImageDigest &&
    expected &&
    outcome.agentImageDigest !== expected
  );
}

/**
 * One sweep over every registered host: probe each agent and persist
 * healthy/unhealthy plus reported agent info exactly like
 * handleCheckHostHealth, except a pending host stays pending on failure
 * (pending means enrollment was never confirmed, which is not the same as an
 * agent that went down). Persistence is best-effort per host: one failing
 * write is logged and never crashes the sweep or drops the host from the
 * result. Runs in the worker on an interval, never on the request path.
 */
export async function handleSweepAgentInventory(
  deps: AgentsInventoryDeps,
  now: Date = new Date(),
): Promise<AgentInventoryEntry[]> {
  const hosts = await deps.repo.findAll();
  // Absent resolver means no comparison this sweep: every host stays unflagged instead of guessing.
  // Resolved concurrently with the probes so a slow registry call cannot delay host health updates.
  const [expectedAgentDigest, probeOutcomes] = await Promise.all([
    deps.resolveAgentImageDigest
      ? deps.resolveAgentImageDigest(getAgentImage()).catch(() => null)
      : Promise.resolve(null),
    Promise.all(
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
    ),
  ]);
  const outcomes = probeOutcomes;

  await Promise.all(
    hosts.map(async (host, i) => {
      const outcome = outcomes[i];
      if (!outcome) return;
      try {
        // Stamp the probe time for every host we probed, including a pending one
        // whose status is left alone below: checkedAt answers "when did the sweep
        // last look at this agent", not "when did its status last change".
        await deps.repo.updateLastSweptAt(host.id, now);
        if (host.status === 'pending' && !outcome.healthy) return;
        await deps.repo.updateStatus(host.id, outcome.healthy ? 'healthy' : 'unhealthy');
        const agentOutOfDate = agentOutOfDateFor(outcome, expectedAgentDigest);
        if (outcome.healthy && (outcome.version || outcome.infoSupported)) {
          await deps.repo.updateAgentInfo(host.id, {
            version: outcome.version,
            ...(outcome.infoSupported
              ? {
                  image: outcome.agentImage ?? null,
                  imageTag: outcome.agentImageTag ?? null,
                  imageDigest: outcome.agentImageDigest ?? null,
                  outOfDate: agentOutOfDate,
                }
              : {}),
          });
        }
      } catch (err) {
        console.error(
          `[agent-inventory] Failed to persist sweep result for host ${host.name}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );

  return hosts.map((host, i) => buildAgentInventoryEntry(host, outcomes[i], now, agentOutOfDateFor(outcomes[i], expectedAgentDigest)));
}

/**
 * Stored inventory snapshot for the listing endpoint. Zero network I/O: reads
 * the rows the worker sweep persists and derives entries from them.
 */
export async function handleListAgentsInventorySnapshot(
  deps: HostHandlerDeps,
): Promise<AgentInventoryEntry[]> {
  const hosts = await deps.repo.findAll();
  return hosts.map(buildStoredAgentInventoryEntry);
}

import type { ManagedHost, HostStatus } from '@/lib/database/repositories/host-repository';
import { toHostListItem } from '@/lib/hosts/host-utils';
import type { HostListItem, HealthCheckOutcome } from '@/lib/hosts/host-utils';

export type { HostListItem } from '@/lib/hosts/host-utils';

export interface KeypairsDep {
  createForHost: (hostName: string) => Promise<{ publicJwk: import('jose').JWK }>;
  deleteForHost: (hostName: string) => Promise<void>;
}

export interface AddHostResult {
  host: HostListItem;
  publicJwk?: import('jose').JWK;
}

export type HostOperationResult =
  | { hostId: number; healthy: true; version?: string; dockerVersion?: string }
  | { hostId: number; healthy: false; error: string; suggestions?: string[] };

export type HealthCheckResult = HostOperationResult;

export interface HostRepo {
  findById(id: number): Promise<ManagedHost | null>;
  findAll(): Promise<ManagedHost[]>;
  create(input: { name: string; agentUrl: string; capabilities?: { docker?: boolean; zfs?: boolean } }): Promise<ManagedHost>;
  delete(id: number): Promise<void>;
  updateStatus(id: number, status: HostStatus): Promise<void>;
  updateAgentVersion(id: number, version: string): Promise<void>;
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

  if (healthResult.healthy && healthResult.version) {
    await deps.repo.updateAgentVersion(host.id, healthResult.version);
  }

  return healthResult.healthy
    ? { hostId: host.id, healthy: true, version: healthResult.version, dockerVersion: healthResult.dockerVersion }
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

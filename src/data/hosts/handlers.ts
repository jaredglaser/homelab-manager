import type { ManagedHost, HostStatus } from '@/lib/database/repositories/host-repository';
import { toHostListItem, retryHealthCheck, getAgentImage, HEALTH_CHECK_DELAYS_MS } from '@/lib/hosts/host-utils';
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
export type UpdateAgentResult = HostOperationResult;

export interface HostRepo {
  findById(id: number): Promise<ManagedHost | null>;
  findAll(): Promise<ManagedHost[]>;
  create(input: { name: string; agentUrl: string; capabilities?: { docker?: boolean; zfs?: boolean } }): Promise<ManagedHost>;
  delete(id: number): Promise<void>;
  updateStatus(id: number, status: HostStatus): Promise<void>;
  updateAgentVersion(id: number, version: string): Promise<void>;
  updateAgentUrl(id: number, agentUrl: string): Promise<void>;
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
  deps: HostHandlerDeps & { keypairs: KeypairsDep },
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

export async function handleRefreshHostStatus(
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

  // 3. Trigger update on agent
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

  if (triggerResponse.status !== 202) {
    const body = await triggerResponse.text().catch(() => '');
    return {
      hostId: host.id,
      healthy: false,
      error: body || `Unexpected status ${triggerResponse.status} from agent update endpoint`,
      suggestions: [
        'Check that the agent is reachable at its configured URL',
        'Run `docker logs hlm-agent` to inspect agent errors',
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
        'Run `docker logs hlm-agent` for pull or start errors',
        'Manually run `docker compose up -d` in the agent directory if needed',
        'Check available disk space for the image pull',
      ],
    };
  }

  // 5. Success
  await deps.repo.updateStatus(host.id, 'healthy');
  await deps.repo.updateAgentVersion(host.id, newVersion);
  return { hostId: host.id, healthy: true, version: newVersion };
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
  // the name is immutable. Renaming means remove-and-re-add (which redeploys the
  // agent container with a new AGENT_HOST_NAME anyway).
  if (data.name !== undefined && data.name.trim() !== host.name) {
    throw new Error('Host name cannot be changed after enrollment. To rename, remove and re-add the host.');
  }

  const fields: { agentUrl?: string } = {};
  if (data.agentUrl !== undefined) fields.agentUrl = data.agentUrl;

  const updated = await deps.repo.update(data.hostId, fields);
  return toHostListItem(updated);
}

/**
 * Register an existing agent that's already running. No container provisioning:
 * creates the DB record and generates a keypair. Status is pending until the
 * operator installs the public JWK in the agent's AGENT_TRUSTED_PUBKEY env and
 * a follow-up health check passes.
 */
export async function handleRegisterExistingHost(
  deps: HostHandlerDeps & { keypairs: KeypairsDep },
  data: { name: string; agentUrl: string },
): Promise<AddHostResult> {
  const name = data.name.trim();
  const host = await deps.repo.create({
    name,
    agentUrl: data.agentUrl,
  });

  let publicJwk;
  try {
    ({ publicJwk } = await deps.keypairs.createForHost(name));
  } catch (err) {
    await deps.repo.delete(host.id);
    throw new Error(
      `Failed to generate agent keypair: ${err instanceof Error ? err.message : err}. Host record cleaned up.`
    );
  }

  return {
    host: toHostListItem(host, { agentVersion: null, status: 'pending' }),
    publicJwk,
  };
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function tryRemoveAgent(
  removeAgent: (socketProxyUrl: string, hostId: number) => Promise<void>,
  socketProxyUrl: string,
  hostId: number,
  context: string,
): Promise<boolean> {
  try {
    await removeAgent(socketProxyUrl, hostId);
    return true;
  } catch (err) {
    console.error(`[addHost] Failed to clean up agent container ${context}:`, errorMessage(err));
    return false;
  }
}

async function tryDeleteKeypair(
  keypairs: KeypairsDep,
  hostname: string,
  context: string,
): Promise<void> {
  try {
    await keypairs.deleteForHost(hostname);
  } catch (err) {
    console.error(`[addHost] Failed to delete agent keypair for ${hostname} ${context}:`, errorMessage(err));
  }
}

interface AddHostDeps extends HostHandlerDeps {
  provision: (socketProxyUrl: string, opts: { hostId: number; hostName: string; agentPort: number; publicJwkJson: string; agentImage: string; socketProxyUrl: string }) => Promise<{ agentUrl: string }>;
  keypairs: KeypairsDep;
  checkHealth: (url: string, hostName: string) => Promise<HealthCheckOutcome>;
  removeAgent: (socketProxyUrl: string, hostId: number) => Promise<void>;
}

interface AddHostInput { name: string; socketProxyUrl: string; agentPort: number }

/** Roll back all resources when post-provision finalization fails */
async function rollbackPostProvision(
  deps: AddHostDeps, hostId: number, data: AddHostInput, err: unknown, containerContext: string,
): Promise<never> {
  await deps.repo.delete(hostId);
  const containerCleaned = await tryRemoveAgent(deps.removeAgent, data.socketProxyUrl, hostId, containerContext);
  const suffix = containerCleaned
    ? 'Host record and container have been cleaned up.'
    : 'Host record deleted but agent container cleanup failed; manual removal may be required.';
  throw new Error(`Failed to finalize host after provisioning: ${errorMessage(err)}. ${suffix}`);
}

/** Roll back all resources when the health check fails */
async function rollbackHealthCheckFailure(
  deps: AddHostDeps, hostId: number, data: AddHostInput, healthError: string,
): Promise<never> {
  await tryDeleteKeypair(deps.keypairs, data.name, 'during rollback');
  const containerCleaned = await tryRemoveAgent(deps.removeAgent, data.socketProxyUrl, hostId, `for ${data.name} after health check failure`);
  await deps.repo.delete(hostId);
  const suffix = containerCleaned
    ? 'Host record, keypair, and container have been cleaned up.'
    : 'Host record and keypair deleted but agent container cleanup failed; manual removal may be required.';
  throw new Error(`Agent provisioned but health check failed after 3 attempts: ${healthError}. ${suffix}`);
}

/** Finalize the host record after a successful health check */
async function finalizeHostRecord(
  deps: AddHostDeps, hostId: number, data: AddHostInput, healthResult: HealthCheckOutcome & { healthy: true },
): Promise<void> {
  try {
    await deps.repo.updateStatus(hostId, 'healthy');
    if (healthResult.version) await deps.repo.updateAgentVersion(hostId, healthResult.version);
  } catch (err) {
    await tryDeleteKeypair(deps.keypairs, data.name, 'during finalization rollback');
    const containerCleaned = await tryRemoveAgent(deps.removeAgent, data.socketProxyUrl, hostId, `for ${data.name} during finalization rollback`);
    await deps.repo.delete(hostId);
    const suffix = containerCleaned
      ? 'Host record, keypair, and container have been cleaned up.'
      : 'Host record and keypair deleted but agent container cleanup failed; manual removal may be required.';
    console.error(`[addHost] Agent is healthy but failed to finalize host record for ${data.name}:`, errorMessage(err), suffix);
    throw new Error(`Agent is healthy but failed to finalize host record: ${errorMessage(err)}. ${suffix}`);
  }
}

export async function handleAddHost(
  deps: AddHostDeps,
  dataInput: AddHostInput,
): Promise<AddHostResult> {
  const data: AddHostInput = { ...dataInput, name: dataInput.name.trim() };

  const host = await deps.repo.create({
    name: data.name,
    agentUrl: '',
  });

  let publicJwk;
  try {
    ({ publicJwk } = await deps.keypairs.createForHost(data.name));
  } catch (err) {
    await deps.repo.delete(host.id);
    throw err;
  }

  let provisionResult;
  try {
    provisionResult = await deps.provision(data.socketProxyUrl, {
      hostId: host.id,
      hostName: data.name,
      agentPort: data.agentPort,
      publicJwkJson: JSON.stringify(publicJwk),
      agentImage: getAgentImage(),
      socketProxyUrl: data.socketProxyUrl,
    });
  } catch (err) {
    await tryDeleteKeypair(deps.keypairs, data.name, 'after provision failure');
    await deps.repo.delete(host.id);
    throw err;
  }

  try {
    await deps.repo.updateAgentUrl(host.id, provisionResult.agentUrl);
  } catch (err) {
    await rollbackPostProvision(deps, host.id, data, err, `for ${data.name} after post-provision failure`);
  }

  const healthResult = await retryHealthCheck((url) => deps.checkHealth(url, data.name), provisionResult.agentUrl, [500, 1000, 2000]);

  if (!healthResult.healthy) {
    return rollbackHealthCheckFailure(deps, host.id, data, healthResult.error);
  }

  await finalizeHostRecord(deps, host.id, data, healthResult);

  return {
    host: toHostListItem(
      { ...host, agentUrl: provisionResult.agentUrl },
      { agentVersion: healthResult.version || null, status: 'healthy' },
    ),
    publicJwk,
  };
}

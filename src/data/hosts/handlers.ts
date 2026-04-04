import type { ManagedHostRow, HostStatus } from '@/lib/database/repositories/host-repository';
import { toHostListItem, retryHealthCheck, getAgentImage, HEALTH_CHECK_DELAYS_MS } from '@/lib/hosts/host-utils';
import type { HostListItem, HealthCheckOutcome } from '@/lib/hosts/host-utils';

export type { HostListItem } from '@/lib/hosts/host-utils';

export interface AddHostResult {
  host: HostListItem;
}

export type HostOperationResult =
  | { hostId: number; healthy: true; version?: string; dockerVersion?: string }
  | { hostId: number; healthy: false; error: string; suggestions?: string[] };

export type HealthCheckResult = HostOperationResult;
export type UpdateAgentResult = HostOperationResult;

export interface HostRepo {
  findById(id: number): Promise<ManagedHostRow | null>;
  findAll(): Promise<ManagedHostRow[]>;
  create(input: { name: string; agent_url: string; capabilities?: { docker?: boolean; zfs?: boolean } }): Promise<ManagedHostRow>;
  delete(id: number): Promise<void>;
  updateStatus(id: number, status: HostStatus): Promise<void>;
  updateAgentVersion(id: number, version: string): Promise<void>;
  updateAgentUrl(id: number, agentUrl: string): Promise<void>;
  update(id: number, fields: { name?: string; agent_url?: string; capabilities?: { docker?: boolean; zfs?: boolean } }): Promise<ManagedHostRow>;
}

export interface HostHandlerDeps {
  repo: HostRepo;
}

export async function handleListHosts(deps: HostHandlerDeps): Promise<HostListItem[]> {

  const hosts = await deps.repo.findAll();
  return hosts.map((h) => toHostListItem(h));
}

export async function handleCheckHostHealth(
  deps: HostHandlerDeps & { checkHealth: (url: string) => Promise<HealthCheckOutcome> },
  data: { hostId: number },
): Promise<HostOperationResult> {


  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  const healthResult = await deps.checkHealth(host.agent_url);
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
  deps: HostHandlerDeps & {
    deleteToken: (hostname: string) => Promise<void>;
  },
  data: { hostId: number },
): Promise<{ success: boolean }> {


  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  try {
    await deps.deleteToken(host.name);
  } catch (err) {
    console.error(`[removeHost] Failed to delete OpenBao token for ${host.name}:`, err instanceof Error ? err.message : err);
  }

  await deps.repo.delete(data.hostId);
  return { success: true };
}

export async function handleRefreshHostStatus(
  deps: HostHandlerDeps & { checkHealth: (url: string) => Promise<HealthCheckOutcome> },
  data: { hostId: number },
): Promise<HostOperationResult> {
  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  const healthResult = await deps.checkHealth(host.agent_url);
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
    getToken: (hostname: string) => Promise<string>;
    checkHealth: (url: string) => Promise<HealthCheckOutcome>;
  },
  data: { hostId: number },
): Promise<HostOperationResult> {
  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  // 1. Record current version before update
  const preCheck = await deps.checkHealth(host.agent_url);
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

  // 2. Fetch token
  let token: string;
  try {
    token = await deps.getToken(host.name);
  } catch {
    return {
      hostId: host.id,
      healthy: false,
      error: 'Could not retrieve agent token',
      suggestions: [
        'Check that the OpenBao container is running',
        'Verify that OPENBAO_TOKEN is set correctly in your environment',
      ],
    };
  }

  // 3. Trigger update on agent
  let triggerResponse: Response;
  try {
    const agentBaseUrl = host.agent_url.replace(/\/+$/, '');
    triggerResponse = await fetch(`${agentBaseUrl}/agent/update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
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
    lastResult = await deps.checkHealth(host.agent_url);
    if (lastResult.healthy && lastResult.version !== currentVersion) {
      newVersion = lastResult.version;
      break;
    }
  }

  if (!newVersion) {
    if (lastResult.healthy) {
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

  const fields: { name?: string; agent_url?: string } = {};
  if (data.name !== undefined) fields.name = data.name;
  if (data.agentUrl !== undefined) fields.agent_url = data.agentUrl;

  const updated = await deps.repo.update(data.hostId, fields);
  return toHostListItem(updated);
}

/**
 * Register an existing agent that's already running. No container provisioning —
 * just creates the DB record, stores the token in OpenBao, and health-checks.
 */
export async function handleRegisterExistingHost(
  deps: HostHandlerDeps & {
    storeToken: (hostname: string, token: string) => Promise<void>;
    checkHealth: (url: string) => Promise<HealthCheckOutcome>;
  },
  data: { name: string; agentUrl: string; agentToken: string },
): Promise<AddHostResult> {


  const host = await deps.repo.create({
    name: data.name,
    agent_url: data.agentUrl,
  });

  try {
    await deps.storeToken(data.name, data.agentToken);
  } catch (err) {
    await deps.repo.delete(host.id);
    throw new Error(
      `Failed to store agent token in OpenBao: ${err instanceof Error ? err.message : err}. Host record has been cleaned up.`
    );
  }

  const healthResult = await retryHealthCheck(deps.checkHealth, data.agentUrl, HEALTH_CHECK_DELAYS_MS.slice(0, 3));
  const status: HostStatus = healthResult.healthy ? 'healthy' : 'unhealthy';
  await deps.repo.updateStatus(host.id, status);

  if (healthResult.healthy && healthResult.version) {
    await deps.repo.updateAgentVersion(host.id, healthResult.version);
  }

  return {
    host: toHostListItem(host, {
      agentVersion: (healthResult.healthy && healthResult.version) ? healthResult.version : null,
      status,
    }),
  };
}

/**
 * Verify and register a user-managed agent. Health-checks first (before creating
 * any DB record), then creates the host record and stores the token in OpenBao.
 */
export async function handleVerifyHost(
  deps: HostHandlerDeps & {
    storeToken: (hostname: string, token: string) => Promise<void>;
    checkHealth: (url: string) => Promise<HealthCheckOutcome>;
    verifyToken: (agentUrl: string, token: string) => Promise<void>;
  },
  data: { name: string; agentUrl: string; agentToken: string; capabilities?: { docker?: boolean; zfs?: boolean } },
): Promise<AddHostResult> {


  // 1. Health check the agent before creating any records
  const healthResult = await retryHealthCheck(deps.checkHealth, data.agentUrl, HEALTH_CHECK_DELAYS_MS.slice(0, 3));
  if (!healthResult.healthy) {
    throw new Error(`Agent health check failed: ${healthResult.error}`);
  }

  // 2. Verify the token is accepted by the agent before storing anything
  await deps.verifyToken(data.agentUrl, data.agentToken);

  // 3. Create DB record
  const host = await deps.repo.create({
    name: data.name,
    agent_url: data.agentUrl,
    capabilities: data.capabilities,
  });

  // 4. Store token in OpenBao
  try {
    await deps.storeToken(data.name, data.agentToken);
  } catch (err) {
    await deps.repo.delete(host.id);
    throw new Error(`Failed to store agent token in OpenBao: ${err instanceof Error ? err.message : err}. Host record has been cleaned up.`);
  }

  // 5. Update status
  const status: HostStatus = 'healthy';
  await deps.repo.updateStatus(host.id, status);
  if (healthResult.version) await deps.repo.updateAgentVersion(host.id, healthResult.version);

  return {
    host: toHostListItem(host, { agentVersion: healthResult.version || null, status }),
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

async function tryDeleteToken(
  deleteToken: (hostname: string) => Promise<void>,
  hostname: string,
  context: string,
): Promise<void> {
  try {
    await deleteToken(hostname);
  } catch (err) {
    console.error(`[addHost] Failed to delete OpenBao token for ${hostname} ${context}:`, errorMessage(err));
  }
}

interface AddHostDeps extends HostHandlerDeps {
  provision: (socketProxyUrl: string, opts: { hostId: number; agentPort: number; agentToken: string; agentImage: string; socketProxyUrl: string }) => Promise<{ agentUrl: string }>;
  generateToken: () => string;
  storeToken: (hostname: string, token: string) => Promise<void>;
  deleteToken: (hostname: string) => Promise<void>;
  checkHealth: (url: string) => Promise<HealthCheckOutcome>;
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
    : 'Host record deleted but agent container cleanup failed — manual removal may be required.';
  throw new Error(`Failed to finalize host after provisioning: ${errorMessage(err)}. ${suffix}`);
}

/** Roll back all resources when the health check fails */
async function rollbackHealthCheckFailure(
  deps: AddHostDeps, hostId: number, data: AddHostInput, healthError: string,
): Promise<never> {
  await tryDeleteToken(deps.deleteToken, data.name, 'during rollback');
  const containerCleaned = await tryRemoveAgent(deps.removeAgent, data.socketProxyUrl, hostId, `for ${data.name} after health check failure`);
  await deps.repo.delete(hostId);
  const suffix = containerCleaned
    ? 'Host record, token, and container have been cleaned up.'
    : 'Host record and token deleted but agent container cleanup failed — manual removal may be required.';
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
    await tryDeleteToken(deps.deleteToken, data.name, 'during finalization rollback');
    const containerCleaned = await tryRemoveAgent(deps.removeAgent, data.socketProxyUrl, hostId, `for ${data.name} during finalization rollback`);
    await deps.repo.delete(hostId);
    const suffix = containerCleaned
      ? 'Host record, token, and container have been cleaned up.'
      : 'Host record and token deleted but agent container cleanup failed — manual removal may be required.';
    console.error(`[addHost] Agent is healthy but failed to finalize host record for ${data.name}:`, errorMessage(err), suffix);
    throw new Error(`Agent is healthy but failed to finalize host record: ${errorMessage(err)}. ${suffix}`);
  }
}

export async function handleAddHost(
  deps: AddHostDeps,
  data: AddHostInput,
): Promise<AddHostResult> {


  const plainToken = deps.generateToken();

  const host = await deps.repo.create({
    name: data.name,
    agent_url: '',
  });

  let provisionResult;
  try {
    provisionResult = await deps.provision(data.socketProxyUrl, {
      hostId: host.id,
      agentPort: data.agentPort,
      agentToken: plainToken,
      agentImage: getAgentImage(),
      socketProxyUrl: data.socketProxyUrl,
    });
  } catch (err) {
    await deps.repo.delete(host.id);
    throw err;
  }

  try {
    await deps.repo.updateAgentUrl(host.id, provisionResult.agentUrl);
    await deps.storeToken(data.name, plainToken);
  } catch (err) {
    await rollbackPostProvision(deps, host.id, data, err, `for ${data.name} after post-provision failure`);
  }

  const healthResult = await retryHealthCheck(deps.checkHealth, provisionResult.agentUrl, [500, 1000, 2000]);

  if (!healthResult.healthy) {
    return rollbackHealthCheckFailure(deps, host.id, data, healthResult.error);
  }

  const status: HostStatus = 'healthy';
  await finalizeHostRecord(deps, host.id, data, healthResult);

  return {
    host: toHostListItem(
      { ...host, agent_url: provisionResult.agentUrl },
      { agentVersion: healthResult.version || null, status },
    ),
  };
}

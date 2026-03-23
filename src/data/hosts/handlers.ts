import type { ManagedHost, HostStatus } from '@/lib/database/repositories/host-repository';
import { toHostListItem, retryHealthCheck, getAgentImage } from '@/lib/hosts/host-utils';
import type { HostListItem, HealthCheckOutcome } from '@/lib/hosts/host-utils';

export type { HostListItem } from '@/lib/hosts/host-utils';

export interface AddHostResult {
  host: HostListItem;
}

export type HostOperationResult =
  | { hostId: number; healthy: true; version?: string; dockerVersion?: string }
  | { hostId: number; healthy: false; error: string };

export type HealthCheckResult = HostOperationResult;
export type UpdateAgentResult = HostOperationResult;

export interface HostRepo {
  findById(id: number): Promise<ManagedHost | null>;
  findAll(): Promise<ManagedHost[]>;
  create(input: { name: string; agent_url: string; socket_proxy_url: string }): Promise<ManagedHost>;
  delete(id: number): Promise<void>;
  updateStatus(id: number, status: HostStatus): Promise<void>;
  updateAgentVersion(id: number, version: string): Promise<void>;
  updateAgentUrl(id: number, agentUrl: string): Promise<void>;
}

export interface HostHandlerDeps {
  repo: HostRepo;
  isEnabled: () => boolean;
}

export async function handleListHosts(deps: HostHandlerDeps): Promise<HostListItem[]> {
  if (!deps.isEnabled()) throw new Error('Docker management feature is not enabled');
  const hosts = await deps.repo.findAll();
  return hosts.map((h) => toHostListItem(h));
}

export async function handleCheckHostHealth(
  deps: HostHandlerDeps & { checkHealth: (url: string) => Promise<HealthCheckOutcome> },
  data: { hostId: number },
): Promise<HostOperationResult> {
  if (!deps.isEnabled()) throw new Error('Docker management feature is not enabled');

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
    removeAgent: (socketProxyUrl: string, hostId: number) => Promise<void>;
    deleteToken: (hostname: string) => Promise<void>;
  },
  data: { hostId: number },
): Promise<{ success: boolean; containerRemoved: boolean; warning?: string }> {
  if (!deps.isEnabled()) throw new Error('Docker management feature is not enabled');

  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  let containerRemoved = true;
  try {
    await deps.removeAgent(host.socket_proxy_url, host.id);
  } catch (err) {
    containerRemoved = false;
    console.error(
      `[removeHost] Failed to remove agent container for ${host.name}:`,
      err instanceof Error ? err.message : err
    );
  }

  try {
    await deps.deleteToken(host.name);
  } catch (err) {
    console.error(`[removeHost] Failed to delete OpenBao token for ${host.name}:`, err instanceof Error ? err.message : err);
  }

  await deps.repo.delete(data.hostId);
  return {
    success: true,
    containerRemoved,
    warning: containerRemoved
      ? undefined
      : `Host record deleted, but the agent container on ${host.name} could not be removed. It may need manual cleanup.`,
  };
}

export async function handleUpdateAgent(
  deps: HostHandlerDeps & { updateAgent: (socketProxyUrl: string, hostId: number) => Promise<{ healthy: boolean; version?: string; error?: string }> },
  data: { hostId: number },
): Promise<HostOperationResult> {
  if (!deps.isEnabled()) throw new Error('Docker management feature is not enabled');

  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  let result: { healthy: boolean; version?: string; error?: string };
  try {
    result = await deps.updateAgent(host.socket_proxy_url, host.id);
  } catch (err) {
    try {
      await deps.repo.updateStatus(host.id, 'unhealthy');
    } catch (statusErr) {
      console.error(`[updateAgent] Failed to update status for host ${host.id}:`, statusErr instanceof Error ? statusErr.message : statusErr);
    }
    return { hostId: host.id, healthy: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (result.healthy) {
    await deps.repo.updateStatus(host.id, 'healthy');
    if (result.version) await deps.repo.updateAgentVersion(host.id, result.version);
    return { hostId: host.id, healthy: true, version: result.version };
  }

  await deps.repo.updateStatus(host.id, 'unhealthy');
  return { hostId: host.id, healthy: false, error: result.error ?? 'Unknown error' };
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

export async function handleAddHost(
  deps: HostHandlerDeps & {
    provision: (socketProxyUrl: string, opts: { hostId: number; agentPort: number; agentToken: string; agentImage: string; socketProxyUrl: string }) => Promise<{ agentUrl: string }>;
    generateToken: () => string;
    storeToken: (hostname: string, token: string) => Promise<void>;
    deleteToken: (hostname: string) => Promise<void>;
    checkHealth: (url: string) => Promise<HealthCheckOutcome>;
    removeAgent: (socketProxyUrl: string, hostId: number) => Promise<void>;
  },
  data: { name: string; socketProxyUrl: string; agentPort: number },
): Promise<AddHostResult> {
  if (!deps.isEnabled()) throw new Error('Docker management feature is not enabled');

  const plainToken = deps.generateToken();

  const host = await deps.repo.create({
    name: data.name,
    agent_url: '',
    socket_proxy_url: data.socketProxyUrl,
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
    await deps.repo.delete(host.id);
    const containerCleaned = await tryRemoveAgent(deps.removeAgent, data.socketProxyUrl, host.id, `for ${data.name} after post-provision failure`);
    const suffix = containerCleaned
      ? 'Host record and container have been cleaned up.'
      : 'Host record deleted but agent container cleanup failed — manual removal may be required.';
    throw new Error(`Failed to finalize host after provisioning: ${errorMessage(err)}. ${suffix}`);
  }

  const healthResult = await retryHealthCheck(deps.checkHealth, provisionResult.agentUrl, [500, 1000, 2000]);

  if (!healthResult.healthy) {
    await tryDeleteToken(deps.deleteToken, data.name, 'during rollback');
    const containerCleaned = await tryRemoveAgent(deps.removeAgent, data.socketProxyUrl, host.id, `for ${data.name} after health check failure`);
    await deps.repo.delete(host.id);
    const suffix = containerCleaned
      ? 'Host record, token, and container have been cleaned up.'
      : 'Host record and token deleted but agent container cleanup failed — manual removal may be required.';
    throw new Error(`Agent provisioned but health check failed after 3 attempts: ${healthResult.error}. ${suffix}`);
  }

  const status: HostStatus = 'healthy';
  try {
    await deps.repo.updateStatus(host.id, status);
    if (healthResult.version) await deps.repo.updateAgentVersion(host.id, healthResult.version);
  } catch (err) {
    console.error(`[addHost] Agent is healthy but failed to finalize host record for ${data.name}:`, errorMessage(err));
    await tryDeleteToken(deps.deleteToken, data.name, 'during finalization rollback');
    await tryRemoveAgent(deps.removeAgent, data.socketProxyUrl, host.id, `for ${data.name} during finalization rollback`);
    await deps.repo.delete(host.id);
    throw new Error(`Agent is healthy but failed to finalize host record: ${errorMessage(err)}`);
  }

  return {
    host: toHostListItem(
      { ...host, agent_url: provisionResult.agentUrl },
      { agentVersion: healthResult.version || null, status },
    ),
  };
}

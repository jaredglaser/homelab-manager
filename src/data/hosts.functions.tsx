import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { HostStatus } from '@/lib/database/repositories/host-repository';
import {
  parseDockerodeConfig,
  toHostListItem,
  retryHealthCheck,
  getAgentImage,
} from '@/lib/hosts/host-utils';
import type { HostListItem, HealthCheckOutcome } from '@/lib/hosts/host-utils';

// ----- Schemas -----

export const socketProxyUrlSchema = z.string().min(1).refine(
  (val) => /^(tcp|http|https):\/\/.+/.test(val),
  { message: 'Must be a valid URL with tcp://, http://, or https:// scheme' }
);

export const addHostSchema = z.object({
  name: z.string().min(1).max(100),
  socketProxyUrl: socketProxyUrlSchema,
  agentPort: z.number().int().min(1).max(65535).optional().default(9090),
});

export const removeHostSchema = z.object({
  hostId: z.number().int().positive(),
});

export const updateAgentSchema = z.object({
  hostId: z.number().int().positive(),
});

export const checkHostHealthSchema = z.object({
  hostId: z.number().int().positive(),
});

// ----- Types -----

export type { HostListItem } from '@/lib/hosts/host-utils';

export interface AddHostResult {
  host: HostListItem;
}

export interface HostOperationResult {
  hostId: number;
  healthy: boolean;
  version?: string;
  dockerVersion?: string;
  error?: string;
}

export type HealthCheckResult = HostOperationResult;
export type UpdateAgentResult = HostOperationResult;

// ----- Handler dependencies -----

export interface HostRepo {
  findById(id: number): Promise<{ id: number; name: string; agent_url: string; socket_proxy_url: string; agent_version: string | null; agent_token_hash: string; agent_token: string | null; status: HostStatus; created_at: Date; updated_at: Date } | null>;
  findAll(): Promise<{ id: number; name: string; agent_url: string; socket_proxy_url: string; agent_version: string | null; agent_token_hash: string; agent_token: string | null; status: HostStatus; created_at: Date; updated_at: Date }[]>;
  create(input: { name: string; agent_url: string; agent_token_hash: string; agent_token: string; socket_proxy_url: string }): Promise<{ id: number; name: string; agent_url: string; socket_proxy_url: string; agent_version: string | null; agent_token_hash: string; agent_token: string | null; status: HostStatus; created_at: Date; updated_at: Date }>;
  delete(id: number): Promise<void>;
  updateStatus(id: number, status: HostStatus): Promise<void>;
  updateAgentVersion(id: number, version: string): Promise<void>;
  updateAgentUrl(id: number, agentUrl: string): Promise<void>;
}

export interface HostHandlerDeps {
  repo: HostRepo;
  isEnabled: () => boolean;
}

// ----- Exported handler functions (testable via DI) -----

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
  deps: HostHandlerDeps & { removeAgent: (socketProxyUrl: string, hostId: number) => Promise<void> },
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
    try { await deps.repo.updateStatus(host.id, 'unhealthy'); } catch (statusErr) {
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
  return { hostId: host.id, healthy: false, error: result.error };
}

export async function handleAddHost(
  deps: HostHandlerDeps & {
    provision: (socketProxyUrl: string, opts: { hostId: number; agentPort: number; agentToken: string; agentImage: string; socketProxyUrl: string }) => Promise<{ agentUrl: string }>;
    generateToken: () => string;
    hashToken: (token: string) => Promise<string>;
    checkHealth: (url: string) => Promise<HealthCheckOutcome>;
    removeAgent: (socketProxyUrl: string, hostId: number) => Promise<void>;
  },
  data: { name: string; socketProxyUrl: string; agentPort: number },
): Promise<AddHostResult> {
  if (!deps.isEnabled()) throw new Error('Docker management feature is not enabled');

  const plainToken = deps.generateToken();
  const tokenHash = await deps.hashToken(plainToken);

  // Create DB record first (as 'pending') so we have a stable hostId for the container name.
  const host = await deps.repo.create({
    name: data.name,
    agent_url: '', // placeholder until provisioning resolves the URL
    agent_token_hash: tokenHash,
    agent_token: plainToken,
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
    throw new Error(
      `Failed to provision agent on host '${data.name}': ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let healthResult: HealthCheckOutcome;
  try {
    healthResult = await retryHealthCheck(deps.checkHealth, provisionResult.agentUrl, [500, 1000, 2000]);
  } catch (err) {
    // retryHealthCheck threw (unexpected) — clean up container and record
    await bestEffortCleanup(deps, data, host.id);
    throw err;
  }

  if (!healthResult.healthy) {
    let cleanupSucceeded = true;
    try {
      await deps.removeAgent(data.socketProxyUrl, host.id);
    } catch (cleanupErr) {
      cleanupSucceeded = false;
      console.error(
        `[addHost] Failed to clean up agent container for ${data.name} after health check failure:`,
        cleanupErr instanceof Error ? cleanupErr.message : cleanupErr
      );
    }
    await deps.repo.delete(host.id);
    throw new Error(
      cleanupSucceeded
        ? `Agent provisioned but health check failed after 3 attempts: ${healthResult.error}. Host record and container have been cleaned up.`
        : `Agent provisioned but health check failed after 3 attempts: ${healthResult.error}. Host record was deleted but agent container cleanup failed — manual removal may be required.`
    );
  }

  // Post-health-check DB updates — agent is running and healthy at this point.
  // If these fail, clean up to avoid a half-initialized record with a live container.
  try {
    await deps.repo.updateAgentUrl(host.id, provisionResult.agentUrl);
    await deps.repo.updateStatus(host.id, 'healthy');
  } catch (err) {
    await bestEffortCleanup(deps, data, host.id);
    throw new Error(
      `Agent is healthy but failed to finalize host record: ${err instanceof Error ? err.message : String(err)}. Host record and container have been cleaned up.`
    );
  }

  // Version update is metadata-only — don't roll back a healthy host for this
  if (healthResult.version) {
    try { await deps.repo.updateAgentVersion(host.id, healthResult.version); } catch (err) {
      console.error(`[addHost] Failed to save agent version for ${data.name}:`, err instanceof Error ? err.message : err);
    }
  }

  return {
    host: toHostListItem(host, { agentUrl: provisionResult.agentUrl, agentVersion: healthResult.version || null, status: 'healthy' }),
  };
}

async function bestEffortCleanup(
  deps: { removeAgent: (socketProxyUrl: string, hostId: number) => Promise<void>; repo: { delete(id: number): Promise<void> } },
  data: { socketProxyUrl: string; name: string },
  hostId: number,
): Promise<void> {
  try { await deps.removeAgent(data.socketProxyUrl, hostId); } catch (err) {
    console.error(`[addHost] Best-effort container cleanup failed for ${data.name}:`, err instanceof Error ? err.message : err);
  }
  try { await deps.repo.delete(hostId); } catch (err) {
    console.error(`[addHost] Best-effort record cleanup failed for ${data.name}:`, err instanceof Error ? err.message : err);
  }
}

// ----- Dependency wiring (dynamic imports for server-only modules) -----

async function loadDeps(): Promise<HostHandlerDeps> {
  const { isDockerManagementEnabled } = await import('@/lib/config/feature-flags');
  // Check flag before loading DB to avoid unnecessary connection attempts
  if (!isDockerManagementEnabled()) {
    return { repo: null as unknown as HostRepo, isEnabled: () => false };
  }
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { HostRepository } = await import('@/lib/database/repositories/host-repository');
  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  return { repo: new HostRepository(dbClient.getPool()), isEnabled: isDockerManagementEnabled };
}

async function loadDockerClient(socketProxyUrl: string) {
  const Dockerode = (await import('dockerode')).default;
  return new Dockerode(parseDockerodeConfig(socketProxyUrl));
}

// ----- createServerFn wrappers (thin wiring only) -----

export const addHost = createServerFn()
  .inputValidator(addHostSchema)
  .handler(async ({ data }): Promise<AddHostResult> => {
    const baseDeps = await loadDeps();
    if (!baseDeps.isEnabled()) throw new Error('Docker management feature is not enabled');
    const { generateToken, hashToken } = await import('@/lib/services/token-service');
    const { AgentProvisioningService } = await import('@/lib/services/agent-provisioning-service');
    const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
    const provService = new AgentProvisioningService();
    return handleAddHost({
      ...baseDeps,
      generateToken, hashToken,
      checkHealth: checkAgentHealth,
      provision: async (url, opts) => { const docker = await loadDockerClient(url); return provService.provision(docker, opts); },
      removeAgent: async (url, hostId) => { const docker = await loadDockerClient(url); await provService.removeAgent(docker, hostId); },
    }, data);
  });

export const removeHost = createServerFn()
  .inputValidator(removeHostSchema)
  .handler(async ({ data }): Promise<{ success: boolean; containerRemoved: boolean; warning?: string }> => {
    const baseDeps = await loadDeps();
    if (!baseDeps.isEnabled()) throw new Error('Docker management feature is not enabled');
    const { AgentProvisioningService } = await import('@/lib/services/agent-provisioning-service');
    const provService = new AgentProvisioningService();
    return handleRemoveHost({
      ...baseDeps,
      removeAgent: async (url, hostId) => { const docker = await loadDockerClient(url); await provService.removeAgent(docker, hostId); },
    }, data);
  });

export const listHosts = createServerFn()
  .handler(async (): Promise<HostListItem[]> => {
    const deps = await loadDeps();
    return handleListHosts(deps);
  });

export const updateAgent = createServerFn()
  .inputValidator(updateAgentSchema)
  .handler(async ({ data }): Promise<HostOperationResult> => {
    const baseDeps = await loadDeps();
    if (!baseDeps.isEnabled()) throw new Error('Docker management feature is not enabled');
    const { AgentUpdateService } = await import('@/lib/services/agent-update-service');
    const svc = new AgentUpdateService();
    return handleUpdateAgent({
      ...baseDeps,
      updateAgent: async (url, hostId) => { const docker = await loadDockerClient(url); return svc.updateAgent(docker, hostId, getAgentImage()); },
    }, data);
  });

export const checkHostHealth = createServerFn()
  .inputValidator(checkHostHealthSchema)
  .handler(async ({ data }): Promise<HostOperationResult> => {
    const baseDeps = await loadDeps();
    if (!baseDeps.isEnabled()) throw new Error('Docker management feature is not enabled');
    const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
    return handleCheckHostHealth({ ...baseDeps, checkHealth: checkAgentHealth }, data);
  });

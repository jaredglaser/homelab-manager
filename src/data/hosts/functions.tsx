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

const socketProxyUrlSchema = z.string().min(1).refine(
  (val) => /^(tcp|http|https):\/\/.+/.test(val),
  { message: 'Must be a valid URL with tcp://, http://, or https:// scheme' }
);

const addHostSchema = z.object({
  name: z.string().min(1).max(100),
  socketProxyUrl: socketProxyUrlSchema,
  agentPort: z.number().int().min(1).max(65535).optional().default(9090),
});

const registerExistingHostSchema = z.object({
  name: z.string().min(1).max(100),
  agentUrl: z.string().url(),
  socketProxyUrl: socketProxyUrlSchema,
  agentToken: z.string().min(1),
});

const removeHostSchema = z.object({
  hostId: z.number().int().positive(),
});

const updateAgentSchema = z.object({
  hostId: z.number().int().positive(),
});

const checkHostHealthSchema = z.object({
  hostId: z.number().int().positive(),
});

const updateHostSchema = z.object({
  hostId: z.number().int().positive(),
  name: z.string().min(1).max(100).optional(),
  agentUrl: z.string().url().optional(),
  socketProxyUrl: socketProxyUrlSchema.optional(),
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
  findById(id: number): Promise<{ id: number; name: string; agent_url: string; socket_proxy_url: string; agent_version: string | null; status: HostStatus; created_at: Date; updated_at: Date } | null>;
  findAll(): Promise<{ id: number; name: string; agent_url: string; socket_proxy_url: string; agent_version: string | null; status: HostStatus; created_at: Date; updated_at: Date }[]>;
  create(input: { name: string; agent_url: string; socket_proxy_url: string }): Promise<{ id: number; name: string; agent_url: string; socket_proxy_url: string; agent_version: string | null; status: HostStatus; created_at: Date; updated_at: Date }>;
  update(id: number, fields: { name?: string; agent_url?: string; socket_proxy_url?: string }): Promise<{ id: number; name: string; agent_url: string; socket_proxy_url: string; agent_version: string | null; status: HostStatus; created_at: Date; updated_at: Date }>;
  delete(id: number): Promise<void>;
  updateStatus(id: number, status: HostStatus): Promise<void>;
  updateAgentVersion(id: number, version: string): Promise<void>;
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
    await deps.repo.updateStatus(host.id, 'unhealthy');
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

export async function handleUpdateHost(
  deps: HostHandlerDeps,
  data: { hostId: number; name?: string; agentUrl?: string; socketProxyUrl?: string },
): Promise<HostListItem> {
  if (!deps.isEnabled()) throw new Error('Docker management feature is not enabled');

  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  const fields: { name?: string; agent_url?: string; socket_proxy_url?: string } = {};
  if (data.name !== undefined) fields.name = data.name;
  if (data.agentUrl !== undefined) fields.agent_url = data.agentUrl;
  if (data.socketProxyUrl !== undefined) fields.socket_proxy_url = data.socketProxyUrl;

  const updated = await deps.repo.update(data.hostId, fields);
  return toHostListItem(updated);
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

  // Create DB record first (as 'pending') so we have a stable hostId for the container name.
  const host = await deps.repo.create({
    name: data.name,
    agent_url: '', // placeholder until provisioning resolves the URL
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
    await deps.storeToken(data.name, plainToken);
  } catch (err) {
    await deps.repo.delete(host.id);
    try { await deps.removeAgent(data.socketProxyUrl, host.id); } catch { /* best-effort */ }
    throw new Error(
      `Failed to store agent token in OpenBao: ${err instanceof Error ? err.message : err}. Host record and container have been cleaned up.`
    );
  }

  const healthResult = await retryHealthCheck(deps.checkHealth, provisionResult.agentUrl, [500, 1000, 2000]);

  if (!healthResult.healthy) {
    try { await deps.deleteToken(data.name); } catch { /* best-effort */ }
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
        ? `Agent provisioned but health check failed after 3 attempts: ${healthResult.error}. Host record, token, and container have been cleaned up.`
        : `Agent provisioned but health check failed after 3 attempts: ${healthResult.error}. Host record and token deleted but agent container cleanup failed — manual removal may be required.`
    );
  }

  const status: HostStatus = 'healthy';
  await deps.repo.updateStatus(host.id, status);
  if (healthResult.version) await deps.repo.updateAgentVersion(host.id, healthResult.version);

  return {
    host: toHostListItem(host, { agentVersion: healthResult.version || null, status }),
  };
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
  data: { name: string; agentUrl: string; socketProxyUrl: string; agentToken: string },
): Promise<AddHostResult> {
  if (!deps.isEnabled()) throw new Error('Docker management feature is not enabled');

  const host = await deps.repo.create({
    name: data.name,
    agent_url: data.agentUrl,
    socket_proxy_url: data.socketProxyUrl,
  });

  try {
    await deps.storeToken(data.name, data.agentToken);
  } catch (err) {
    await deps.repo.delete(host.id);
    throw new Error(
      `Failed to store agent token in OpenBao: ${err instanceof Error ? err.message : err}. Host record has been cleaned up.`
    );
  }

  const healthResult = await retryHealthCheck(deps.checkHealth, data.agentUrl, [500, 1000, 2000]);
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
    const { generateToken } = await import('@/lib/services/token-service');
    const { AgentProvisioningService } = await import('@/lib/services/agent-provisioning-service');
    const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
    const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
    const { loadOpenBaoConfig } = await import('@/lib/config/openbao-config');
    const baoClient = new OpenBaoClient(loadOpenBaoConfig());
    const provService = new AgentProvisioningService();
    return handleAddHost({
      ...baseDeps,
      generateToken,
      storeToken: (hostname, token) => baoClient.setHostSecret(hostname, 'agent_token', token),
      deleteToken: (hostname) => baoClient.deleteHostSecret(hostname, 'agent_token'),
      checkHealth: checkAgentHealth,
      provision: async (url, opts) => { const docker = await loadDockerClient(url); return provService.provision(docker, opts); },
      removeAgent: async (url, hostId) => { const docker = await loadDockerClient(url); await provService.removeAgent(docker, hostId); },
    }, data);
  });

export const registerExistingHost = createServerFn()
  .inputValidator(registerExistingHostSchema)
  .handler(async ({ data }): Promise<AddHostResult> => {
    const baseDeps = await loadDeps();
    if (!baseDeps.isEnabled()) throw new Error('Docker management feature is not enabled');
    const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
    const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
    const { loadOpenBaoConfig } = await import('@/lib/config/openbao-config');
    const { initializeOpenBao } = await import('@/lib/services/openbao-init');
    const baoClient = new OpenBaoClient(loadOpenBaoConfig());
    await initializeOpenBao(baoClient);
    return handleRegisterExistingHost({
      ...baseDeps,
      storeToken: (hostname, token) => baoClient.setHostSecret(hostname, 'agent_token', token),
      checkHealth: checkAgentHealth,
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
      deleteToken: async (hostname) => {
        const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
        const { loadOpenBaoConfig } = await import('@/lib/config/openbao-config');
        const baoClient = new OpenBaoClient(loadOpenBaoConfig());
        await baoClient.deleteHostSecret(hostname, 'agent_token');
      },
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
    const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
    return handleCheckHostHealth({ ...baseDeps, checkHealth: checkAgentHealth }, data);
  });

export const updateHost = createServerFn()
  .inputValidator(updateHostSchema)
  .handler(async ({ data }): Promise<HostListItem> => {
    const deps = await loadDeps();
    return handleUpdateHost(deps, data);
  });

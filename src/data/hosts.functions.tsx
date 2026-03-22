import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { HostCapabilities, HostStatus } from '@/lib/database/repositories/host-repository';
import {
  toHostListItem,
  retryHealthCheck,
} from '@/lib/hosts/host-utils';
import type { HostListItem, HealthCheckOutcome } from '@/lib/hosts/host-utils';

// ----- Schemas -----

const verifyHostSchema = z.object({
  name: z.string().min(1).max(100),
  agentUrl: z.string().url(),
  agentToken: z.string().min(1),
  capabilities: z.object({
    docker: z.boolean().optional().default(false),
    zfs: z.boolean().optional().default(false),
  }).optional().default({ docker: false, zfs: false }),
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
  findById(id: number): Promise<{ id: number; name: string; agent_url: string; capabilities: HostCapabilities; agent_version: string | null; status: HostStatus; created_at: Date; updated_at: Date } | null>;
  findAll(): Promise<{ id: number; name: string; agent_url: string; capabilities: HostCapabilities; agent_version: string | null; status: HostStatus; created_at: Date; updated_at: Date }[]>;
  create(input: { name: string; agent_url: string; capabilities?: HostCapabilities }): Promise<{ id: number; name: string; agent_url: string; capabilities: HostCapabilities; agent_version: string | null; status: HostStatus; created_at: Date; updated_at: Date }>;
  update(id: number, fields: { name?: string; agent_url?: string; capabilities?: HostCapabilities }): Promise<{ id: number; name: string; agent_url: string; capabilities: HostCapabilities; agent_version: string | null; status: HostStatus; created_at: Date; updated_at: Date }>;
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
    deleteToken: (hostname: string) => Promise<void>;
  },
  data: { hostId: number },
): Promise<{ success: boolean }> {
  if (!deps.isEnabled()) throw new Error('Docker management feature is not enabled');

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

export async function handleUpdateAgent(
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

export async function handleUpdateHost(
  deps: HostHandlerDeps,
  data: { hostId: number; name?: string; agentUrl?: string },
): Promise<HostListItem> {
  if (!deps.isEnabled()) throw new Error('Docker management feature is not enabled');

  const host = await deps.repo.findById(data.hostId);
  if (!host) throw new Error(`Host with id ${data.hostId} not found`);

  const fields: { name?: string; agent_url?: string } = {};
  if (data.name !== undefined) fields.name = data.name;
  if (data.agentUrl !== undefined) fields.agent_url = data.agentUrl;

  const updated = await deps.repo.update(data.hostId, fields);
  return toHostListItem(updated);
}

export async function handleVerifyHost(
  deps: HostHandlerDeps & {
    storeToken: (hostname: string, token: string) => Promise<void>;
    checkHealth: (url: string) => Promise<HealthCheckOutcome>;
  },
  data: { name: string; agentUrl: string; agentToken: string; capabilities?: { docker?: boolean; zfs?: boolean } },
): Promise<AddHostResult> {
  if (!deps.isEnabled()) throw new Error('Docker management feature is not enabled');

  // 1. Health check the agent
  const healthResult = await retryHealthCheck(deps.checkHealth, data.agentUrl, [500, 1000, 2000]);
  if (!healthResult.healthy) {
    throw new Error(`Agent health check failed: ${healthResult.error}`);
  }

  // 2. Create DB record
  const host = await deps.repo.create({
    name: data.name,
    agent_url: data.agentUrl,
    capabilities: data.capabilities,
  });

  // 3. Store token in OpenBao
  try {
    await deps.storeToken(data.name, data.agentToken);
  } catch (err) {
    await deps.repo.delete(host.id);
    throw new Error(`Failed to store agent token in OpenBao: ${err instanceof Error ? err.message : err}. Host record has been cleaned up.`);
  }

  // 4. Update status
  const status: HostStatus = 'healthy';
  await deps.repo.updateStatus(host.id, status);
  if (healthResult.version) await deps.repo.updateAgentVersion(host.id, healthResult.version);

  return {
    host: toHostListItem(host, { agentVersion: healthResult.version || null, status }),
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

// ----- createServerFn wrappers (thin wiring only) -----

export const verifyHost = createServerFn()
  .inputValidator(verifyHostSchema)
  .handler(async ({ data }): Promise<AddHostResult> => {
    const baseDeps = await loadDeps();
    if (!baseDeps.isEnabled()) throw new Error('Docker management feature is not enabled');
    const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
    const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
    const { loadOpenBaoConfig } = await import('@/lib/config/openbao-config');
    const { initializeOpenBao } = await import('@/lib/services/openbao-init');
    const baoClient = new OpenBaoClient(loadOpenBaoConfig());
    await initializeOpenBao(baoClient);
    return handleVerifyHost({
      ...baseDeps,
      storeToken: (hostname, token) => baoClient.setHostSecret(hostname, 'agent_token', token),
      checkHealth: checkAgentHealth,
    }, data);
  });

export const removeHost = createServerFn()
  .inputValidator(removeHostSchema)
  .handler(async ({ data }): Promise<{ success: boolean }> => {
    const baseDeps = await loadDeps();
    if (!baseDeps.isEnabled()) throw new Error('Docker management feature is not enabled');
    const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
    const { loadOpenBaoConfig } = await import('@/lib/config/openbao-config');
    const baoClient = new OpenBaoClient(loadOpenBaoConfig());
    return handleRemoveHost({
      ...baseDeps,
      deleteToken: (hostname) => baoClient.deleteHostSecret(hostname, 'agent_token'),
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
    const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
    return handleUpdateAgent({ ...baseDeps, checkHealth: checkAgentHealth }, data);
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

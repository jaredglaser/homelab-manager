import { createServerFn } from '@tanstack/react-start';
import { parseDockerodeConfig, getAgentImage } from '@/lib/hosts/host-utils';
import type { HostListItem } from '@/lib/hosts/host-utils';
import { addHostSchema, removeHostSchema, updateAgentSchema, checkHostHealthSchema, registerExistingHostSchema, updateHostSchema } from '@/data/hosts/schemas';
import {
  handleListHosts, handleCheckHostHealth, handleRemoveHost,
  handleUpdateAgent, handleAddHost, handleUpdateHost, handleRegisterExistingHost,
  type AddHostResult, type HostOperationResult, type HostHandlerDeps, type HostRepo,
} from '@/data/hosts/handlers';

export type { HostListItem, AddHostResult, HostOperationResult, HealthCheckResult, UpdateAgentResult } from '@/data/hosts/handlers';

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
    await baoClient.ensureSecretsEngine();
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

import { createServerFn } from '@tanstack/react-start';
import type { HostListItem } from '@/lib/hosts/host-utils';
import { addHostSchema, removeHostSchema, updateAgentSchema, checkHostHealthSchema, registerExistingHostSchema, verifyHostSchema, updateHostSchema } from '@/data/hosts/schemas';
import {
  handleListHosts, handleCheckHostHealth, handleRemoveHost,
  handleUpdateAgent, handleAddHost, handleUpdateHost, handleRegisterExistingHost, handleVerifyHost,
  type AddHostResult, type HostOperationResult, type HostHandlerDeps,
} from '@/data/hosts/handlers';

export type { HostListItem, AddHostResult, HostOperationResult, HealthCheckResult, UpdateAgentResult } from '@/data/hosts/handlers';

async function loadDeps(): Promise<HostHandlerDeps> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { HostRepository } = await import('@/lib/database/repositories/host-repository');
  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  return { repo: new HostRepository(dbClient.getPool()) };
}

async function loadDockerClient(socketProxyUrl: string) {
  const Dockerode = (await import('dockerode')).default;
  let parsed: URL;
  try {
    parsed = new URL(socketProxyUrl.replace(/^tcp:/, 'http:'));
  } catch {
    throw new Error(`Invalid socketProxyUrl "${socketProxyUrl}": must be a valid URL with tcp://, http://, or https:// scheme`);
  }
  return new Dockerode({ host: parsed.hostname, port: Number(parsed.port) || 2375 });
}

export const addHost = createServerFn()
  .inputValidator(addHostSchema)
  .handler(async ({ data }): Promise<AddHostResult> => {
    const baseDeps = await loadDeps();

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

export const verifyHost = createServerFn()
  .inputValidator(verifyHostSchema)
  .handler(async ({ data }): Promise<AddHostResult> => {
    const baseDeps = await loadDeps();

    const { checkAgentHealth, verifyAgentToken } = await import('@/lib/services/agent-health-service');
    const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
    const { loadOpenBaoConfig } = await import('@/lib/config/openbao-config');
    const { initializeOpenBao } = await import('@/lib/services/openbao-init');
    const baoClient = new OpenBaoClient(loadOpenBaoConfig());
    await initializeOpenBao(baoClient);
    return handleVerifyHost({
      ...baseDeps,
      storeToken: (hostname, token) => baoClient.setHostSecret(hostname, 'agent_token', token),
      checkHealth: checkAgentHealth,
      verifyToken: verifyAgentToken,
    }, data);
  });

export const removeHost = createServerFn()
  .inputValidator(removeHostSchema)
  .handler(async ({ data }): Promise<{ success: boolean }> => {
    const baseDeps = await loadDeps();

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
    const { AgentUpdateService } = await import('@/lib/services/agent-update-service');
    const svc = new AgentUpdateService();
    return handleUpdateAgent({
      ...baseDeps,
      updateAgent: async (agentUrl, hostId) => {
        const { getAgentImage } = await import('@/lib/hosts/host-utils');
        return svc.updateAgent(await loadDockerClient(agentUrl), hostId, getAgentImage(), agentUrl);
      },
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

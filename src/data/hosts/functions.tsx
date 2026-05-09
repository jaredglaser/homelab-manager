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

async function loadKeypairsRepo(): Promise<import('@/lib/database/repositories/agent-keypairs-repository').AgentKeypairsRepository> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { AgentKeypairsRepository } = await import('@/lib/database/repositories/agent-keypairs-repository');
  const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
  const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
  const keyring = await loadMasterKeyring();
  return new AgentKeypairsRepository(dbClient.getPool(), keyring);
}

async function loadDockerClient(socketProxyUrl: string) {
  const Dockerode = (await import('dockerode')).default;
  let parsed: URL;
  try {
    parsed = new URL(socketProxyUrl.replace(/^tcp:/, 'http:'));
  } catch {
    throw new Error(`Invalid socketProxyUrl "${socketProxyUrl}": must be a valid URL with tcp://, http://, or https:// scheme`);
  }
  const protocol = parsed.protocol === 'https:' ? 'https' : 'http';
  return new Dockerode({ host: parsed.hostname, port: Number(parsed.port) || 2375, protocol });
}

export const addHost = createServerFn()
  .inputValidator(addHostSchema)
  .handler(async ({ data }): Promise<AddHostResult> => {
    const baseDeps = await loadDeps();
    const { AgentProvisioningService } = await import('@/lib/services/agent-provisioning-service');
    const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
    const keypairs = await loadKeypairsRepo();
    const provService = new AgentProvisioningService();
    return handleAddHost({
      ...baseDeps,
      keypairs: {
        createForHost: (name) => keypairs.createForHost(name).then((r) => ({ publicJwk: r.publicJwk })),
        deleteForHost: (name) => keypairs.deleteForHost(name),
      },
      checkHealth: checkAgentHealth,
      provision: async (url, opts) => {
        const docker = await loadDockerClient(url);
        return provService.provision(docker, opts);
      },
      removeAgent: async (url, hostId) => {
        const docker = await loadDockerClient(url);
        await provService.removeAgent(docker, hostId);
      },
    }, data);
  });

export const registerExistingHost = createServerFn()
  .inputValidator(registerExistingHostSchema)
  .handler(async ({ data }): Promise<AddHostResult> => {
    const baseDeps = await loadDeps();
    const keypairs = await loadKeypairsRepo();
    return handleRegisterExistingHost({
      ...baseDeps,
      keypairs: {
        createForHost: (name) => keypairs.createForHost(name).then((r) => ({ publicJwk: r.publicJwk })),
        deleteForHost: (name) => keypairs.deleteForHost(name),
      },
    }, data);
  });

export const verifyHost = createServerFn()
  .inputValidator(verifyHostSchema)
  .handler(async ({ data }): Promise<AddHostResult> => {
    const baseDeps = await loadDeps();
    const keypairs = await loadKeypairsRepo();
    return handleVerifyHost({
      ...baseDeps,
      keypairs: {
        createForHost: (name) => keypairs.createForHost(name).then((r) => ({ publicJwk: r.publicJwk })),
        deleteForHost: (name) => keypairs.deleteForHost(name),
      },
    }, data);
  });

export const removeHost = createServerFn()
  .inputValidator(removeHostSchema)
  .handler(async ({ data }): Promise<{ success: boolean }> => {
    const baseDeps = await loadDeps();
    return handleRemoveHost({
      ...baseDeps,
      keypairs: {
        createForHost: async (name) => {
          const keypairs = await loadKeypairsRepo();
          return keypairs.createForHost(name).then((r) => ({ publicJwk: r.publicJwk }));
        },
        deleteForHost: async (name) => {
          try {
            const keypairs = await loadKeypairsRepo();
            await keypairs.deleteForHost(name);
          } catch {
            // best-effort: keypair cleanup is non-fatal for host removal
          }
        },
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
    const keypairs = await loadKeypairsRepo();
    const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
    const { signAgentJwt } = await import('@/lib/crypto/agent-jwt');
    return handleUpdateAgent({
      ...baseDeps,
      getSigner: async (hostname) => {
        const privateKey = await keypairs.getPrivateKeyForHost(hostname);
        if (!privateKey) throw new Error(`No agent keypair found for host ${hostname}`);
        return () => signAgentJwt(privateKey, hostname);
      },
      checkHealth: checkAgentHealth,
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

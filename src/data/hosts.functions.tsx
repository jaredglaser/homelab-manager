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

// Custom validator for socket proxy URLs — Zod's .url() only accepts http/https
// but Docker socket proxies use tcp:// scheme
const socketProxyUrlSchema = z.string().min(1).refine(
  (val) => /^(tcp|http|https):\/\/.+/.test(val),
  { message: 'Must be a valid URL with tcp://, http://, or https:// scheme' }
);

const addHostSchema = z.object({
  name: z.string().min(1).max(100),
  socketProxyUrl: socketProxyUrlSchema,
  agentPort: z.number().int().min(1).max(65535).optional().default(9090),
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

// ----- Types (re-export from host-utils) -----

export type { HostListItem } from '@/lib/hosts/host-utils';

export interface AddHostResult {
  host: HostListItem;
  healthy: boolean;
  error?: string;
}

export interface HealthCheckResult {
  hostId: number;
  healthy: boolean;
  version?: string;
  dockerVersion?: string;
  error?: string;
}

export interface UpdateAgentResult {
  hostId: number;
  healthy: boolean;
  version?: string;
  error?: string;
}

// ----- Server Functions -----

// NOTE: Per CLAUDE.md rule 3, all server logic should use createServerFn() + middleware
// injection. When the codebase establishes a middleware pattern (e.g., for auth or
// database connection injection), these server functions should be updated to use
// .middleware([authMiddleware, dbMiddleware]) instead of manually importing and
// constructing dependencies inside each handler.

async function ensureFeatureFlag(): Promise<void> {
  const { isDockerManagementEnabled } = await import(
    '@/lib/config/feature-flags'
  );
  if (!isDockerManagementEnabled()) {
    throw new Error('Docker management feature is not enabled');
  }
}

async function getHostRepo() {
  const { databaseConnectionManager } = await import(
    '@/lib/clients/database-client'
  );
  const { loadDatabaseConfig } = await import(
    '@/lib/config/database-config'
  );
  const { HostRepository } = await import(
    '@/lib/database/repositories/host-repository'
  );
  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  return new HostRepository(dbClient.getPool());
}

async function createDockerClient(socketProxyUrl: string) {
  const Dockerode = (await import('dockerode')).default;
  const config = parseDockerodeConfig(socketProxyUrl);
  return new Dockerode(config);
}

/**
 * Add a new managed host: connect to socket proxy, provision agent, store in DB.
 */
export const addHost = createServerFn()
  .inputValidator(addHostSchema)
  .handler(async ({ data }): Promise<AddHostResult> => {
    await ensureFeatureFlag();

    const { generateToken, hashToken } = await import(
      '@/lib/services/token-service'
    );
    const { AgentProvisioningService } = await import(
      '@/lib/services/agent-provisioning-service'
    );
    const { checkAgentHealth } = await import(
      '@/lib/services/agent-health-service'
    );

    const docker = await createDockerClient(data.socketProxyUrl);

    const plainToken = generateToken();
    const tokenHash = await hashToken(plainToken);

    const provisioningService = new AgentProvisioningService();
    const provisionResult = await provisioningService.provision(docker, {
      hostName: data.name,
      agentPort: data.agentPort,
      agentToken: plainToken,
      agentImage: getAgentImage(),
      socketProxyUrl: data.socketProxyUrl,
    });

    const repo = await getHostRepo();
    const host = await repo.create({
      name: data.name,
      agent_url: provisionResult.agentUrl,
      agent_token_hash: tokenHash,
      agent_token: plainToken,
      socket_proxy_url: data.socketProxyUrl,
    });

    const healthResult = await retryHealthCheck(
      checkAgentHealth,
      provisionResult.agentUrl,
      [500, 1000, 2000],
    );

    if (!healthResult.healthy) {
      try {
        const cleanup = new AgentProvisioningService();
        await cleanup.removeAgent(docker, data.name);
      } catch {
        // Best-effort cleanup
      }
      await repo.delete(host.id);
      throw new Error(
        `Agent provisioned but health check failed after 3 retries: ${healthResult.error}. Host record and container have been cleaned up.`
      );
    }

    const status: HostStatus = 'healthy';
    await repo.updateStatus(host.id, status);

    if (healthResult.version) {
      await repo.updateAgentVersion(host.id, healthResult.version);
    }

    return {
      host: toHostListItem(host, {
        agentVersion: healthResult.version || null,
        status,
      }),
      healthy: healthResult.healthy,
      error: healthResult.error,
    };
  });

/**
 * Remove a managed host: stop + remove agent container, delete DB record.
 */
export const removeHost = createServerFn()
  .inputValidator(removeHostSchema)
  .handler(async ({ data }): Promise<{ success: boolean }> => {
    await ensureFeatureFlag();

    const { AgentProvisioningService } = await import(
      '@/lib/services/agent-provisioning-service'
    );

    const repo = await getHostRepo();
    const host = await repo.findById(data.hostId);
    if (!host) {
      throw new Error(`Host with id ${data.hostId} not found`);
    }

    try {
      const docker = await createDockerClient(host.socket_proxy_url);
      const provisioningService = new AgentProvisioningService();
      await provisioningService.removeAgent(docker, host.name);
    } catch (err) {
      console.error(
        `[removeHost] Failed to remove agent container for ${host.name}:`,
        err instanceof Error ? err.message : err
      );
    }

    await repo.delete(data.hostId);
    return { success: true };
  });

/**
 * List all managed hosts with their current status.
 */
export const listHosts = createServerFn()
  .handler(async (): Promise<HostListItem[]> => {
    await ensureFeatureFlag();
    const repo = await getHostRepo();
    const hosts = await repo.findAll();
    return hosts.map((h) => toHostListItem(h));
  });

/**
 * Update an agent to the latest image version.
 * Bypasses the agent by connecting directly to the socket proxy.
 */
export const updateAgent = createServerFn()
  .inputValidator(updateAgentSchema)
  .handler(async ({ data }): Promise<UpdateAgentResult> => {
    await ensureFeatureFlag();

    const { AgentUpdateService } = await import(
      '@/lib/services/agent-update-service'
    );

    const repo = await getHostRepo();
    const host = await repo.findById(data.hostId);
    if (!host) {
      throw new Error(`Host with id ${data.hostId} not found`);
    }

    const docker = await createDockerClient(host.socket_proxy_url);
    const updateService = new AgentUpdateService();
    const result = await updateService.updateAgent(docker, host.name, getAgentImage());

    if (result.healthy) {
      await repo.updateStatus(host.id, 'healthy');
      if (result.version) {
        await repo.updateAgentVersion(host.id, result.version);
      }
    } else {
      await repo.updateStatus(host.id, 'unhealthy');
    }

    return {
      hostId: host.id,
      healthy: result.healthy,
      version: result.version,
      error: result.error,
    };
  });

/**
 * Check the health of a specific host's agent.
 */
export const checkHostHealth = createServerFn()
  .inputValidator(checkHostHealthSchema)
  .handler(async ({ data }): Promise<HealthCheckResult> => {
    await ensureFeatureFlag();

    const { checkAgentHealth } = await import(
      '@/lib/services/agent-health-service'
    );

    const repo = await getHostRepo();
    const host = await repo.findById(data.hostId);
    if (!host) {
      throw new Error(`Host with id ${data.hostId} not found`);
    }

    const healthResult: HealthCheckOutcome = await checkAgentHealth(host.agent_url);

    const newStatus: HostStatus = healthResult.healthy ? 'healthy' : 'error';
    await repo.updateStatus(host.id, newStatus);

    if (healthResult.version) {
      await repo.updateAgentVersion(host.id, healthResult.version);
    }

    return {
      hostId: host.id,
      healthy: healthResult.healthy,
      version: healthResult.version,
      dockerVersion: healthResult.dockerVersion,
      error: healthResult.error,
    };
  });

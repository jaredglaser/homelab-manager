import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

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

// ----- Types -----

export interface HostListItem {
  id: number;
  name: string;
  agentUrl: string;
  socketProxyUrl: string;
  agentVersion: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

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

// ----- Constants -----

const AGENT_IMAGE_PROD = 'ghcr.io/homelab-manager/agent:latest';
const AGENT_IMAGE_DEV = 'homelab-manager-agent:dev';

function getAgentImage(): string {
  return process.env.NODE_ENV === 'development' ? AGENT_IMAGE_DEV : AGENT_IMAGE_PROD;
}

// ----- Server Functions -----

// NOTE: Per CLAUDE.md rule 3, all server logic should use createServerFn() + middleware
// injection. When the codebase establishes a middleware pattern (e.g., for auth or
// database connection injection), these server functions should be updated to use
// .middleware([authMiddleware, dbMiddleware]) instead of manually importing and
// constructing dependencies inside each handler.

/**
 * Add a new managed host: connect to socket proxy, provision agent, store in DB.
 *
 * Flow:
 * 1. Validate feature flag is enabled
 * 2. Connect to socket proxy via Dockerode
 * 3. Generate token, hash it
 * 4. Provision agent container
 * 5. Store host record in managed_hosts
 * 6. Verify agent health
 * 7. Rollback on failure, or update status to 'online'
 */
export const addHost = createServerFn()
  .inputValidator(addHostSchema)
  .handler(async ({ data }): Promise<AddHostResult> => {
    const { isDockerManagementEnabled } = await import(
      '@/lib/config/feature-flags'
    );
    if (!isDockerManagementEnabled()) {
      throw new Error('Docker management feature is not enabled');
    }

    const Dockerode = (await import('dockerode')).default;
    const { generateToken, hashToken } = await import(
      '@/lib/services/token-service'
    );
    const { AgentProvisioningService } = await import(
      '@/lib/services/agent-provisioning-service'
    );
    const { checkAgentHealth } = await import(
      '@/lib/services/agent-health-service'
    );
    const { databaseConnectionManager } = await import(
      '@/lib/clients/database-client'
    );
    const { loadDatabaseConfig } = await import(
      '@/lib/config/database-config'
    );
    const { HostRepository } = await import(
      '@/lib/database/repositories/host-repository'
    );

    // Parse socket proxy URL for Dockerode connection
    const proxyUrl = new URL(data.socketProxyUrl);
    const docker = new Dockerode({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port) || 2375,
      protocol: (proxyUrl.protocol.replace(':', '') as 'http' | 'https') || 'http',
    });

    // Generate and hash token
    const plainToken = generateToken();
    const tokenHash = await hashToken(plainToken);

    // Provision agent container
    const provisioningService = new AgentProvisioningService();
    const provisionResult = await provisioningService.provision(docker, {
      hostName: data.name,
      agentPort: data.agentPort,
      agentToken: plainToken,
      agentImage: getAgentImage(),
      socketProxyUrl: data.socketProxyUrl,
    });

    // Store host in database
    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new HostRepository(dbClient.getPool());

    const host = await repo.create({
      name: data.name,
      agent_url: provisionResult.agentUrl,
      agent_token_hash: tokenHash,
      agent_token: plainToken,
      socket_proxy_url: data.socketProxyUrl,
    });

    // Health check with exponential backoff retry (matches BaseCollector pattern)
    const healthRetryDelays = [500, 1000, 2000];
    let healthResult: { healthy: boolean; version?: string; error?: string } = { healthy: false, error: 'Health check not attempted' };
    for (const delayMs of healthRetryDelays) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      healthResult = await checkAgentHealth(provisionResult.agentUrl);
      if (healthResult.healthy) break;
    }

    // If health check failed after all retries, rollback: remove container and DB record
    if (!healthResult.healthy) {
      try {
        const provisioningServiceCleanup = new AgentProvisioningService();
        await provisioningServiceCleanup.removeAgent(docker, data.name);
      } catch {
        // Best-effort cleanup
      }
      await repo.delete(host.id);
      throw new Error(
        `Agent provisioned but health check failed after ${healthRetryDelays.length} retries: ${healthResult.error}. Host record and container have been cleaned up.`
      );
    }

    const status = 'online';
    await repo.updateStatus(host.id, status);

    if (healthResult.version) {
      await repo.updateAgentVersion(host.id, healthResult.version);
    }

    return {
      host: {
        id: host.id,
        name: host.name,
        agentUrl: host.agent_url,
        socketProxyUrl: host.socket_proxy_url,
        agentVersion: healthResult.version || null,
        status,
        createdAt: host.created_at.toISOString(),
        updatedAt: host.updated_at.toISOString(),
      },
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
    const { isDockerManagementEnabled } = await import(
      '@/lib/config/feature-flags'
    );
    if (!isDockerManagementEnabled()) {
      throw new Error('Docker management feature is not enabled');
    }

    const Dockerode = (await import('dockerode')).default;
    const { AgentProvisioningService } = await import(
      '@/lib/services/agent-provisioning-service'
    );
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
    const repo = new HostRepository(dbClient.getPool());

    const host = await repo.findById(data.hostId);
    if (!host) {
      throw new Error(`Host with id ${data.hostId} not found`);
    }

    // Connect to socket proxy and remove agent container
    try {
      const proxyUrl = new URL(host.socket_proxy_url);
      const docker = new Dockerode({
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port) || 2375,
        protocol: (proxyUrl.protocol.replace(':', '') as 'http' | 'https') || 'http',
      });

      const provisioningService = new AgentProvisioningService();
      await provisioningService.removeAgent(docker, host.name);
    } catch (err) {
      // Log but don't fail — the host record should still be removed
      // even if the container can't be reached
      console.error(
        `[removeHost] Failed to remove agent container for ${host.name}:`,
        err instanceof Error ? err.message : err
      );
    }

    // Delete from database
    await repo.delete(data.hostId);

    return { success: true };
  });

/**
 * List all managed hosts with their current status.
 * Throws when the feature flag is off, consistent with all other host
 * management functions. The UI should check isDockerManagementEnabled()
 * on the client side before calling this function to avoid showing
 * errors in navigation/sidebar.
 */
export const listHosts = createServerFn()
  .handler(async (): Promise<HostListItem[]> => {
    const { isDockerManagementEnabled } = await import(
      '@/lib/config/feature-flags'
    );
    if (!isDockerManagementEnabled()) {
      throw new Error('Docker management feature is not enabled');
    }

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
    const repo = new HostRepository(dbClient.getPool());

    const hosts = await repo.findAll();

    return hosts.map((h) => ({
      id: h.id,
      name: h.name,
      agentUrl: h.agent_url,
      socketProxyUrl: h.socket_proxy_url,
      agentVersion: h.agent_version,
      status: h.status,
      createdAt: h.created_at.toISOString(),
      updatedAt: h.updated_at.toISOString(),
    }));
  });

/**
 * Update an agent to the latest image version.
 * Bypasses the agent by connecting directly to the socket proxy.
 */
export const updateAgent = createServerFn()
  .inputValidator(updateAgentSchema)
  .handler(async ({ data }): Promise<UpdateAgentResult> => {
    const { isDockerManagementEnabled } = await import(
      '@/lib/config/feature-flags'
    );
    if (!isDockerManagementEnabled()) {
      throw new Error('Docker management feature is not enabled');
    }

    const Dockerode = (await import('dockerode')).default;
    const { AgentUpdateService } = await import(
      '@/lib/services/agent-update-service'
    );
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
    const repo = new HostRepository(dbClient.getPool());

    const host = await repo.findById(data.hostId);
    if (!host) {
      throw new Error(`Host with id ${data.hostId} not found`);
    }

    // Connect directly to socket proxy (bypassing agent)
    const proxyUrl = new URL(host.socket_proxy_url);
    const docker = new Dockerode({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port) || 2375,
      protocol: (proxyUrl.protocol.replace(':', '') as 'http' | 'https') || 'http',
    });

    const updateService = new AgentUpdateService();
    const result = await updateService.updateAgent(docker, host.name, getAgentImage());

    // Update database
    if (result.healthy) {
      await repo.updateStatus(host.id, 'online');
      if (result.version) {
        await repo.updateAgentVersion(host.id, result.version);
      }
    } else {
      await repo.updateStatus(host.id, 'degraded');
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
 * Called on-demand from the UI, not continuous.
 */
export const checkHostHealth = createServerFn()
  .inputValidator(checkHostHealthSchema)
  .handler(async ({ data }): Promise<HealthCheckResult> => {
    const { isDockerManagementEnabled } = await import(
      '@/lib/config/feature-flags'
    );
    if (!isDockerManagementEnabled()) {
      throw new Error('Docker management feature is not enabled');
    }

    const { checkAgentHealth } = await import(
      '@/lib/services/agent-health-service'
    );
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
    const repo = new HostRepository(dbClient.getPool());

    const host = await repo.findById(data.hostId);
    if (!host) {
      throw new Error(`Host with id ${data.hostId} not found`);
    }

    const healthResult = await checkAgentHealth(host.agent_url);

    // Update status in database
    const newStatus = healthResult.healthy ? 'online' : 'offline';
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

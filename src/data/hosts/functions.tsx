import { createServerFn } from '@tanstack/react-start';
import type { HostListItem } from '@/lib/hosts/host-utils';
import type { AgentInventoryEntry } from '@/lib/hosts/agent-inventory';
import { removeHostSchema, checkHostHealthSchema, verifyHostSchema, updateHostSchema, getHostPublicJwkSchema, rotateHostKeypairSchema, rotateHostTlsSchema, updateAgentSchema } from '@/data/hosts/schemas';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';
import {
  handleListHosts, handleCheckHostHealth, handleRemoveHost,
  handleUpdateHost, handleVerifyHost, handleUpdateAgent, handleListAgentsInventorySnapshot, handleGetHostPublicJwk, handleRotateHostKeypair, handleRotateHostTls,
  type AddHostResult, type HostOperationResult, type HostHandlerDeps,
} from '@/data/hosts/handlers';

export type { HostListItem, AddHostResult, HostOperationResult, HealthCheckResult, UpdateAgentResult } from '@/data/hosts/handlers';
export type { AgentInventoryEntry, AgentInventoryStatus, AgentVersionSource } from '@/lib/hosts/agent-inventory';

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

async function loadTlsCertsRepo(): Promise<import('@/lib/database/repositories/agent-tls-certificates-repository').AgentTlsCertificatesRepository> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { AgentTlsCertificatesRepository } = await import('@/lib/database/repositories/agent-tls-certificates-repository');
  const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
  return new AgentTlsCertificatesRepository(dbClient.getPool());
}

/**
 * Build a checkHealth function that probes the unauthenticated /health endpoint
 * for liveness, then pulls version detail from the authenticated /info endpoint
 * with a JWT minted from the host's keypair. Hosts without an enrolled keypair
 * still get a liveness verdict, just without version info.
 */
async function buildCheckHealth(
  keypairs: import('@/lib/database/repositories/agent-keypairs-repository').AgentKeypairsRepository,
  tlsCerts?: import('@/lib/database/repositories/agent-tls-certificates-repository').AgentTlsCertificatesRepository,
): Promise<(url: string, hostName: string) => Promise<import('@/lib/services/agent-health-service').AgentHealthResult>> {
  const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
  const { signAgentJwt } = await import('@/lib/crypto/agent-jwt');
  return async (url, hostName) => {
    let caCertPem: string | null = null;
    if (tlsCerts) {
      try {
        caCertPem = await tlsCerts.getCertForHost(hostName);
      } catch (err) {
        console.error(`[hosts] TLS cert lookup failed for ${hostName}:`, err instanceof Error ? err.message : err);
      }
    }
    return checkAgentHealth(url, undefined, fetch, async () => {
      const privateKey = await keypairs.getPrivateKeyForHost(hostName);
      if (!privateKey) throw new Error(`No agent keypair found for host ${hostName}`);
      return signAgentJwt(privateKey, hostName);
    }, caCertPem);
  };
}

/**
 * checkHealth for read-only probes. The keypair repo needs a master key a deployment
 * may not have, so an unusable keyring degrades to liveness instead of throwing.
 */
async function buildProbeCheckHealth(): Promise<
  (url: string, hostName: string) => Promise<import('@/lib/services/agent-health-service').AgentHealthResult>
> {
  try {
    const keypairs = await loadKeypairsRepo();
    let tlsCerts: import('@/lib/database/repositories/agent-tls-certificates-repository').AgentTlsCertificatesRepository | undefined;
    try {
      tlsCerts = await loadTlsCertsRepo();
    } catch {
      tlsCerts = undefined;
    }
    return await buildCheckHealth(keypairs, tlsCerts);
  } catch (err) {
    console.info(
      '[hosts] Agent keypairs unavailable, probing liveness without version detail:',
      err instanceof Error ? err.message : err,
    );
    const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
    return (url) => checkAgentHealth(url);
  }
}

function makeKeypairsDep(
  keypairs: import('@/lib/database/repositories/agent-keypairs-repository').AgentKeypairsRepository,
) {
  return {
    createForHost: (name: string) => keypairs.createForHost(name).then((r) => ({ publicJwk: r.publicJwk })),
    deleteForHost: (name: string) => keypairs.deleteForHost(name),
    getPublicJwkForHost: (name: string) => keypairs.getPublicJwkForHost(name),
  };
}

/** Pinned cert lets an https rotation enroll over its existing TLS channel. */
function makeProvisionTls(
  keypairs: import('@/lib/database/repositories/agent-keypairs-repository').AgentKeypairsRepository,
  tlsCerts: import('@/lib/database/repositories/agent-tls-certificates-repository').AgentTlsCertificatesRepository,
): (hostName: string, agentUrl: string) => Promise<{ agentUrl: string }> {
  return async (hostName, agentUrl) => {
    const { provisionHostTls } = await import('@/lib/services/agent-provisioning-service');
    const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
    const { signAgentJwt } = await import('@/lib/crypto/agent-jwt');
    const privateKey = await keypairs.getPrivateKeyForHost(hostName);
    if (!privateKey) throw new Error(`No agent keypair found for host ${hostName}`);
    let caCertPem: string | null = null;
    try {
      caCertPem = await tlsCerts.getCertForHost(hostName);
    } catch (err) {
      console.error(`[hosts] TLS cert lookup failed for ${hostName}:`, err instanceof Error ? err.message : err);
    }
    return provisionHostTls(hostName, agentUrl, {
      getSigner: () => signAgentJwt(privateKey, hostName),
      storeCert: (name, certPem) => tlsCerts.createForHost(name, certPem),
      checkHealth: (url, probeHostName, pin) =>
        checkAgentHealth(url, undefined, fetch, () => signAgentJwt(privateKey, probeHostName), pin),
      caCertPem,
    });
  };
}

export const verifyHost = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(verifyHostSchema)
  .handler(async ({ data, context }): Promise<AddHostResult> => {
    requireRole('admin')(context.user);
    const baseDeps = await loadDeps();
    const keypairs = await loadKeypairsRepo();
    const tlsCerts = await loadTlsCertsRepo();
    return handleVerifyHost({
      ...baseDeps,
      keypairs: makeKeypairsDep(keypairs),
      provisionTls: makeProvisionTls(keypairs, tlsCerts),
    }, data);
  });

export const removeHost = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(removeHostSchema)
  .handler(async ({ data, context }): Promise<{ success: boolean }> => {
    requireRole('admin')(context.user);
    const baseDeps = await loadDeps();
    return handleRemoveHost({
      ...baseDeps,
      keypairs: {
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
  .middleware([authMiddleware])
  .handler(async (): Promise<HostListItem[]> => {
    const deps = await loadDeps();
    return handleListHosts(deps);
  });

/**
 * Agents inventory: every registered agent (id, name, status, version, detail)
 * from the stored snapshot the worker's sweep persists. Zero network I/O: this
 * never probes agents, so request latency is flat and client count cannot
 * fan out probes. Live data arrives over the `agent-inventory` WebSocket topic, which
 * pushes a fresh snapshot after each worker sweep. This server function
 * is the initial data source for the admin agents overview.
 */
export const listAgentsInventory = createServerFn()
  .middleware([authMiddleware])
  .handler(async (): Promise<AgentInventoryEntry[]> => {
    const deps = await loadDeps();
    return handleListAgentsInventorySnapshot(deps);
  });

export const checkHostHealth = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(checkHostHealthSchema)
  .handler(async ({ data }): Promise<HostOperationResult> => {
    const baseDeps = await loadDeps();
    return handleCheckHostHealth({ ...baseDeps, checkHealth: await buildProbeCheckHealth() }, data);
  });

export const updateHost = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(updateHostSchema)
  .handler(async ({ data, context }): Promise<HostListItem> => {
    requireRole('admin')(context.user);
    const deps = await loadDeps();
    return handleUpdateHost(deps, data);
  });

export const getHostPublicJwk = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(getHostPublicJwkSchema)
  .handler(async ({ data, context }): Promise<{ publicJwk: import('jose').JWK }> => {
    requireRole('admin')(context.user);
    const baseDeps = await loadDeps();
    const keypairs = await loadKeypairsRepo();
    return handleGetHostPublicJwk({ ...baseDeps, keypairs: makeKeypairsDep(keypairs) }, data);
  });

export const rotateHostKeypair = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(rotateHostKeypairSchema)
  .handler(async ({ data, context }): Promise<{ hostId: number; publicJwk: import('jose').JWK }> => {
    requireRole('admin')(context.user);
    const baseDeps = await loadDeps();
    const keypairs = await loadKeypairsRepo();
    return handleRotateHostKeypair({ ...baseDeps, keypairs: makeKeypairsDep(keypairs) }, data);
  });

export const rotateHostTls = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(rotateHostTlsSchema)
  .handler(async ({ data, context }): Promise<{ hostId: number; agentUrl: string }> => {
    requireRole('admin')(context.user);
    const baseDeps = await loadDeps();
    const keypairs = await loadKeypairsRepo();
    const tlsCerts = await loadTlsCertsRepo();
    return handleRotateHostTls({
      ...baseDeps,
      provisionTls: makeProvisionTls(keypairs, tlsCerts),
    }, data);
  });

export const updateAgent = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(updateAgentSchema)
  .handler(async ({ data, context }): Promise<HostOperationResult> => {
    requireRole('admin')(context.user);
    const baseDeps = await loadDeps();
    const keypairs = await loadKeypairsRepo();
    const tlsCerts = await loadTlsCertsRepo();
    const { signAgentJwt } = await import('@/lib/crypto/agent-jwt');
    return handleUpdateAgent({
      ...baseDeps,
      getSigner: async (hostname) => {
        const privateKey = await keypairs.getPrivateKeyForHost(hostname);
        if (!privateKey) throw new Error(`No agent keypair found for host ${hostname}`);
        return () => signAgentJwt(privateKey, hostname);
      },
      checkHealth: await buildCheckHealth(keypairs, tlsCerts),
      getCaCert: async (hostname) => {
        try {
          return await tlsCerts.getCertForHost(hostname);
        } catch (err) {
          console.error(`[hosts] TLS cert lookup failed for ${hostname}:`, err instanceof Error ? err.message : err);
          return null;
        }
      },
    }, data);
  });


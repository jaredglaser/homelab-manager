import { createServerFn } from '@tanstack/react-start';
import type { HostListItem } from '@/lib/hosts/host-utils';
import { removeHostSchema, checkHostHealthSchema, verifyHostSchema, updateHostSchema } from '@/data/hosts/schemas';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';
import {
  handleListHosts, handleCheckHostHealth, handleRemoveHost,
  handleUpdateHost, handleVerifyHost,
  type AddHostResult, type HostOperationResult, type HostHandlerDeps,
} from '@/data/hosts/handlers';

export type { HostListItem, AddHostResult, HostOperationResult, HealthCheckResult } from '@/data/hosts/handlers';

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

/**
 * Build a checkHealth function that probes the unauthenticated /health endpoint
 * for liveness, then pulls version detail from the authenticated /info endpoint
 * with a JWT minted from the host's keypair. Hosts without an enrolled keypair
 * still get a liveness verdict, just without version info.
 */
async function buildCheckHealth(
  keypairs: import('@/lib/database/repositories/agent-keypairs-repository').AgentKeypairsRepository,
): Promise<(url: string, hostName: string) => Promise<import('@/lib/services/agent-health-service').AgentHealthResult>> {
  const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
  const { signAgentJwt } = await import('@/lib/crypto/agent-jwt');
  return (url, hostName) =>
    checkAgentHealth(url, undefined, fetch, async () => {
      const privateKey = await keypairs.getPrivateKeyForHost(hostName);
      if (!privateKey) throw new Error(`No agent keypair found for host ${hostName}`);
      return signAgentJwt(privateKey, hostName);
    });
}

/**
 * checkHealth for read-only probes. The keypair repo needs a master key a deployment
 * may not have, so an unusable keyring degrades to liveness instead of throwing.
 */
async function buildProbeCheckHealth(): Promise<
  (url: string, hostName: string) => Promise<import('@/lib/services/agent-health-service').AgentHealthResult>
> {
  try {
    return await buildCheckHealth(await loadKeypairsRepo());
  } catch (err) {
    console.info(
      '[hosts] Agent keypairs unavailable, probing liveness without version detail:',
      err instanceof Error ? err.message : err,
    );
    const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
    return (url) => checkAgentHealth(url);
  }
}

export const verifyHost = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(verifyHostSchema)
  .handler(async ({ data, context }): Promise<AddHostResult> => {
    requireRole('admin')(context.user);
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

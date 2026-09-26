import { createServerFn } from '@tanstack/react-start';
import type { HostListItem } from '@/lib/hosts/host-utils';
import type { AgentInventoryEntry } from '@/lib/hosts/agent-inventory';
import { removeHostSchema, checkHostHealthSchema, verifyHostSchema, updateHostSchema, getHostPublicJwkSchema, rotateHostKeypairSchema, updateAgentSchema, setAgentAutoUpdateSchema } from '@/data/hosts/schemas';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';
import {
  handleListHosts, handleCheckHostHealth, handleRemoveHost,
  handleUpdateHost, handleVerifyHost, handleUpdateAgent, handleSetAgentAutoUpdate, handleListAgentsInventorySnapshot, handleGetHostPublicJwk, handleRotateHostKeypair,
  type AddHostResult, type HostOperationResult, type HostHandlerDeps, type SetAgentAutoUpdateResult,
} from '@/data/hosts/handlers';

export type { HostListItem, AddHostResult, HostOperationResult, HealthCheckResult, UpdateAgentResult, SetAgentAutoUpdateResult } from '@/data/hosts/handlers';
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

function makeKeypairsDep(
  keypairs: import('@/lib/database/repositories/agent-keypairs-repository').AgentKeypairsRepository,
) {
  return {
    createForHost: (name: string) => keypairs.createForHost(name).then((r) => ({ publicJwk: r.publicJwk })),
    deleteForHost: (name: string) => keypairs.deleteForHost(name),
    getPublicJwkForHost: (name: string) => keypairs.getPublicJwkForHost(name),
  };
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
      keypairs: makeKeypairsDep(keypairs),
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
 * fan out probes. Live data arrives over the /api/agent-inventory SSE channel,
 * which pushes a fresh snapshot after each worker sweep. This server function
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

/**
 * Manual per-agent update. Admin-only; updates exactly the agent addressed by
 * hostId and never any other agent.
 */
export const updateAgent = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(updateAgentSchema)
  .handler(async ({ data, context }): Promise<HostOperationResult> => {
    requireRole('admin')(context.user);
    const baseDeps = await loadDeps();
    const keypairs = await loadKeypairsRepo();
    const { signAgentJwt } = await import('@/lib/crypto/agent-jwt');
    return handleUpdateAgent({
      ...baseDeps,
      getSigner: async (hostname) => {
        const privateKey = await keypairs.getPrivateKeyForHost(hostname);
        if (!privateKey) throw new Error(`No agent keypair found for host ${hostname}`);
        return () => signAgentJwt(privateKey, hostname);
      },
      checkHealth: await buildCheckHealth(keypairs),
    }, data);
  });

/**
 * Per-agent auto-update opt-in. Admin-only; persists the per-host boolean and
 * best-effort pushes the policy to that agent's agent-updater sidecar.
 */
export const setAgentAutoUpdate = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(setAgentAutoUpdateSchema)
  .handler(async ({ data, context }): Promise<SetAgentAutoUpdateResult> => {
    requireRole('admin')(context.user);
    const baseDeps = await loadDeps();
    const keypairs = await loadKeypairsRepo();
    const { signAgentJwt } = await import('@/lib/crypto/agent-jwt');

    const propagatePolicy = async (
      host: import('@/lib/database/repositories/host-repository').ManagedHost,
      enabled: boolean,
    ): Promise<import('@/data/hosts/handlers').PolicyPropagation> => {
      try {
        const privateKey = await keypairs.getPrivateKeyForHost(host.name);
        if (!privateKey) {
          return { applied: false, warning: `No agent keypair found for host ${host.name}` };
        }
        const jwt = await signAgentJwt(privateKey, host.name);
        const agentBaseUrl = host.agentUrl.replace(/\/+$/, '');
        const response = await fetch(`${agentBaseUrl}/agent/updater-policy`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoUpdate: enabled }),
          redirect: 'manual',
        });
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          return { applied: false, warning: 'Agent URL returned an unexpected redirect' };
        }
        const body = (await response.json().catch(() => ({}))) as { reconfigured?: boolean; reason?: string };
        if (!response.ok || body.reconfigured === false) {
          return { applied: false, warning: body.reason ?? `Agent responded ${response.status}` };
        }
        return { applied: true };
      } catch (err) {
        return {
          applied: false,
          warning: err instanceof Error ? err.message : String(err),
        };
      }
    };

    return handleSetAgentAutoUpdate({ ...baseDeps, propagatePolicy }, data);
  });

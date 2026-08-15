import type { Pool } from 'pg';
import { McpToolError } from '@/lib/mcp/shared';

export interface McpToolContext {
  pool: Pool;
  scopes: string[];
  callAgent: (hostName: string, path: string, init?: RequestInit) => Promise<Response>;
}

export async function buildMcpToolContext(
  pool: Pool,
  scopes: string[],
  requestSignal?: AbortSignal,
): Promise<McpToolContext> {
  const { HostRepository } = await import('@/lib/database/repositories/host-repository');
  const { AgentKeypairsRepository } = await import('@/lib/database/repositories/agent-keypairs-repository');
  const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
  const { signAgentJwt } = await import('@/lib/crypto/agent-jwt');

  const hostRepo = new HostRepository(pool);
  const keyring = await loadMasterKeyring();
  const keypairs = new AgentKeypairsRepository(pool, keyring);

  const callAgent = async (hostName: string, path: string, init: RequestInit = {}): Promise<Response> => {
    const managedHost = await hostRepo.findByName(hostName);
    if (!managedHost) {
      throw new McpToolError('unknown_host', `Unknown host: ${hostName}`);
    }

    const privateKey = await keypairs.getPrivateKeyForHost(hostName);
    if (!privateKey) {
      throw new McpToolError('host_unreachable', `No agent keypair for host: ${hostName}`);
    }

    const jwt = await signAgentJwt(privateKey, hostName);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${jwt}`);

    const signals = [init.signal, requestSignal].filter((s): s is AbortSignal => s != null);

    const agentResponse = await fetch(`${managedHost.agentUrl}${path}`, {
      ...init,
      headers,
      signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      redirect: 'manual',
    });

    if (agentResponse.type === 'opaqueredirect' || (agentResponse.status >= 300 && agentResponse.status < 400)) {
      throw new McpToolError('agent_error', 'Agent URL returned an unexpected redirect');
    }

    return agentResponse;
  };

  return { pool, scopes, callAgent };
}

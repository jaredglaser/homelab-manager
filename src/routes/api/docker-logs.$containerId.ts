import { createFileRoute } from '@tanstack/react-router';
import { createSseStream } from '@/lib/sse/create-sse-stream';

export const Route = createFileRoute('/api/docker-logs/$containerId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { authenticateSSE } = await import('@/lib/auth/sse-auth');
        const user = await authenticateSSE(request);
        if (!user) {
          return new Response('Unauthorized', { status: 401 });
        }

        const { containerId } = params;
        const url = new URL(request.url);
        const hostName = url.searchParams.get('host');

        if (!hostName) {
          return new Response('Missing host query parameter', { status: 400 });
        }

        const { databaseConnectionManager } = await import('@/lib/clients/database-client');
        const { loadDatabaseConfig } = await import('@/lib/config/database-config');
        const { HostRepository } = await import('@/lib/database/repositories/host-repository');
        const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
        const hostRepo = new HostRepository(dbClient.getPool());
        const managedHost = await hostRepo.findByName(hostName);

        if (!managedHost) {
          return new Response(`Unknown host: ${hostName}`, { status: 404 });
        }

        const { AgentKeypairsRepository } = await import('@/lib/database/repositories/agent-keypairs-repository');
        const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
        const { signAgentJwt } = await import('@/lib/crypto/agent-jwt');
        const keyring = await loadMasterKeyring();
        const keypairs = new AgentKeypairsRepository(dbClient.getPool(), keyring);
        const privateKey = await keypairs.getPrivateKeyForHost(hostName);

        if (!privateKey) {
          return new Response(`No agent keypair for host: ${hostName}`, { status: 503 });
        }

        const jwt = await signAgentJwt(privateKey, hostName);

        const agentUrl = `${managedHost.agentUrl}/logs/${encodeURIComponent(containerId)}`;
        const agentResponse = await fetch(agentUrl, {
          headers: { Authorization: `Bearer ${jwt}` },
          signal: request.signal,
          redirect: 'manual',
        });

        if (agentResponse.type === 'opaqueredirect' || (agentResponse.status >= 300 && agentResponse.status < 400)) {
          return new Response('Agent URL returned an unexpected redirect', { status: 502 });
        }

        if (!agentResponse.ok || !agentResponse.body) {
          const msg = await agentResponse.text().catch(() => 'Agent request failed');
          return new Response(msg, { status: agentResponse.status });
        }

        // Pipe the agent's already-framed SSE bytes through; request.signal was passed to fetch() above, so abort propagates.
        const agentBody = agentResponse.body;

        return createSseStream(request, {
          onStart: async (emit, signal) => {
            const reader = agentBody.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done || signal.aborted) break;
                emit.raw(value);
              }
            } catch {
              // Agent stream errored or client disconnected.
            } finally {
              reader.releaseLock();
            }
          },
        });
      },
    },
  },
});

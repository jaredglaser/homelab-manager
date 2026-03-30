import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/docker-logs/$containerId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
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

        const { loadOpenBaoConfig } = await import('@/lib/config/openbao-config');
        const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
        const baoClient = new OpenBaoClient(loadOpenBaoConfig());
        const token = await baoClient.getHostSecret(hostName, 'agent_token');

        if (!token) {
          return new Response(`No agent token for host: ${hostName}`, { status: 503 });
        }

        const agentUrl = `${managedHost.agent_url}/logs/${encodeURIComponent(containerId)}`;
        const agentResponse = await fetch(agentUrl, {
          headers: { Authorization: `Bearer ${token}` },
          signal: request.signal,
        });

        if (!agentResponse.ok || !agentResponse.body) {
          const msg = await agentResponse.text().catch(() => 'Agent request failed');
          return new Response(msg, { status: agentResponse.status });
        }

        return new Response(agentResponse.body, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });
      },
    },
  },
});

import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/ansible-inventory')({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }): Promise<Response> => {
        const { handleInventoryRequest } = await import('@/lib/ansible/inventory-handler');
        const { loadAnsibleConfig } = await import('@/lib/config/ansible-config');
        const { databaseConnectionManager } = await import('@/lib/clients/database-client');
        const { loadDatabaseConfig } = await import('@/lib/config/database-config');
        const { HostRepository } = await import('@/lib/database/repositories/host-repository');

        return handleInventoryRequest(request, {
          loadConfig: loadAnsibleConfig,
          listHosts: async () => {
            const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
            return new HostRepository(dbClient.getPool()).findAll();
          },
        });
      },
    },
  },
});

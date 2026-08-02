import { describe, it, expect, mock } from 'bun:test';

const findAll = mock(async () => [
  {
    id: 1,
    name: 'host-a',
    agentUrl: 'https://host-a.example:9090',
    capabilities: { docker: true },
    agentVersion: null,
    status: 'healthy',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
]);

mock.module('@/lib/config/ansible-config', () => ({
  loadAnsibleConfig: mock(() => ({
    enabled: true,
    sidecarUrl: 'http://sidecar:9095',
    sidecarToken: 'tok',
    remoteUser: 'ansible',
    appdataRoot: '/srv/appdata',
    selfHostName: null,
  })),
}));

mock.module('@/lib/clients/database-client', () => ({
  databaseConnectionManager: { getClient: mock(async () => ({ getPool: () => ({}) })) },
}));

mock.module('@/lib/config/database-config', () => ({ loadDatabaseConfig: mock(() => ({})) }));

mock.module('@/lib/database/repositories/host-repository', () => ({
  HostRepository: mock().mockImplementation(() => ({ findAll })),
}));

const { Route } = await import('@/routes/api/ansible-inventory');

type RouteHandler = (args: { request: Request }) => Promise<Response>;

function handler(): RouteHandler {
  const options = Route.options as { server?: { handlers?: { GET?: RouteHandler } } };
  const get = options.server?.handlers?.GET;
  if (!get) throw new Error('GET handler not registered');
  return get;
}

describe('/api/ansible-inventory', () => {
  it('serves the managed hosts as an Ansible inventory to the sidecar token', async () => {
    const response = await handler()({
      request: new Request('http://app/api/ansible-inventory', {
        headers: { authorization: 'Bearer tok' },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { _meta: { hostvars: Record<string, unknown> } };
    expect(Object.keys(body._meta.hostvars)).toEqual(['host-a']);
  });

  it('rejects a request without the sidecar token', async () => {
    const response = await handler()({ request: new Request('http://app/api/ansible-inventory') });
    expect(response.status).toBe(401);
  });
});

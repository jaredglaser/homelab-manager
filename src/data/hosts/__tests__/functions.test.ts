import { describe, it, expect, mock, beforeEach, spyOn, afterAll } from 'bun:test';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import type { AuthUser, Role } from '@/lib/auth/types';
import { withStartContext } from '@/lib/test/start-context';
import { mockModule } from '@/lib/test/mock-module';
import { ForbiddenError } from '@/lib/auth/require-role';
import type * as AuthMiddleware from '@/middleware/auth-middleware';
import type * as DatabaseClient from '@/lib/clients/database-client';
import type * as DatabaseConfig from '@/lib/config/database-config';
import type * as MasterKey from '@/lib/crypto/master-key';
import type * as HostRepository from '@/lib/database/repositories/host-repository';
import type * as AgentHealthService from '@/lib/services/agent-health-service';

let activeUser: AuthUser = SYNTHETIC_ADMIN;

async function withRole<T>(role: Role, run: () => Promise<T>): Promise<T> {
  activeUser = { ...SYNTHETIC_ADMIN, role };
  try {
    return await run();
  } finally {
    activeUser = SYNTHETIC_ADMIN;
  }
}

type Next = (opts: { sendContext?: unknown; context?: unknown }) => unknown;

mockModule<typeof AuthMiddleware>('@/middleware/auth-middleware', (real) => ({ ...real,
  authMiddleware: {
    options: {
      type: 'function',
      client: ({ next, sendContext }: { next: Next; sendContext: unknown }) =>
        next({ sendContext: { ...(sendContext as Record<string, unknown>), user: activeUser } }),
      server: ({ next, context }: { next: Next; context: unknown }) =>
        next({ context: { ...(context as Record<string, unknown>), user: activeUser } }),
    },
  },
}));

const mockGetClient = mock(() => Promise.resolve({ getPool: () => ({}) }));

mockModule<typeof DatabaseClient>('@/lib/clients/database-client', (real) => ({ ...real,
  databaseConnectionManager: { getClient: mockGetClient },
}));

mockModule<typeof DatabaseConfig>('@/lib/config/database-config', (real) => ({ ...real,
  loadDatabaseConfig: () => ({}),
}));

mockModule<typeof MasterKey>('@/lib/crypto/master-key', (real) => ({ ...real,
  loadMasterKeyring: () => Promise.reject(new Error('no master key in tests')),
}));

const host = {
  id: 7,
  name: 'server1',
  agentUrl: 'https://server1:9443',
  status: 'healthy',
};
const mockFindById = mock(() => Promise.resolve(host));
const mockUpdateHealth = mock(() => Promise.resolve());
const mockUpdateAgentInfo = mock(() => Promise.resolve());

mockModule<typeof HostRepository>(
  '@/lib/database/repositories/host-repository',
  (real) => ({ ...real,
    HostRepository: class {
      findById = mockFindById;
      updateHealth = mockUpdateHealth;
      updateAgentInfo = mockUpdateAgentInfo;
    },
  }),
);

const mockCheckAgentHealth = mock(() => Promise.resolve({ healthy: true, version: '1.2.3' }));

mockModule<typeof AgentHealthService>('@/lib/services/agent-health-service', (real) => ({ ...real,
  checkAgentHealth: mockCheckAgentHealth,
}));

describe('checkHostHealth', () => {
  const infoSpy = spyOn(console, 'info');

  beforeEach(() => {
    infoSpy.mockImplementation(() => undefined);
    mockGetClient.mockClear();
    mockFindById.mockClear();
    mockUpdateHealth.mockClear();
    mockUpdateAgentInfo.mockClear();
    mockCheckAgentHealth.mockClear();
  });

  afterAll(() => {
    infoSpy.mockRestore();
  });

  it('refuses a viewer without probing the agent or writing health', async () => {
    const { checkHostHealth } = await import('../functions');
    const error = await withRole('viewer', () =>
      withStartContext(() => checkHostHealth({ data: { hostId: 7 } })),
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(mockGetClient).not.toHaveBeenCalled();
    expect(mockCheckAgentHealth).not.toHaveBeenCalled();
    expect(mockUpdateHealth).not.toHaveBeenCalled();
    expect(mockUpdateAgentInfo).not.toHaveBeenCalled();
  });

  it.each(['admin', 'operator'] as const)('probes the agent and stores its health for an %s', async (role) => {
    const { checkHostHealth } = await import('../functions');
    await withRole(role, () => withStartContext(() => checkHostHealth({ data: { hostId: 7 } })));
    expect(mockFindById).toHaveBeenCalledWith(7);
    expect(mockCheckAgentHealth).toHaveBeenCalledWith('https://server1:9443');
    expect(mockUpdateHealth).toHaveBeenCalledWith(7, { status: 'healthy', failure: null }, 'https://server1:9443');
    expect(mockUpdateAgentInfo).toHaveBeenCalledWith(7, { version: '1.2.3' });
  });
});

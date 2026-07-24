import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import { withStartContext } from '@/lib/test/start-context';

// Inject a synthetic admin user so requireRole checks pass in tests.
//
// In tests (no Babel transform), createServerFn's client middleware path calls
// extractedFn(payload) where payload.context = sendContext (starts empty). The
// server handler receives that empty context, so context.user is undefined unless
// we also inject the user on the client path via options.client.
//
// The middleware shape must match TanStack's flattenMiddlewares expectations:
// an object with options.server and/or options.client, and options.middleware undefined.
mock.module('@/middleware/auth-middleware', () => ({
  authMiddleware: {
    options: {
      type: 'function',
      // client path: inject user into sendContext so handler receives context.user
      client: async ({ next, sendContext }: { next: (opts: { sendContext: unknown }) => unknown; sendContext: unknown }) => {
        return next({ sendContext: { ...(sendContext as Record<string, unknown>), user: SYNTHETIC_ADMIN } });
      },
      // server path: inject user into context (used when middleware runs server-side)
      server: async ({ next, context }: { next: (opts: { context: unknown }) => unknown; context: unknown }) => {
        return next({ context: { ...(context as Record<string, unknown>), user: SYNTHETIC_ADMIN } });
      },
    },
  },
  AuthError: class AuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'AuthError';
    }
  },
}));

// stackSecretsMiddleware is used by some stacks functions; mock it so it injects
// a minimal context (pool/keyring) without needing a real DB connection.
mock.module('@/middleware/stack-secrets-middleware', () => ({
  stackSecretsMiddleware: {
    options: {
      type: 'function',
      client: async ({ next, sendContext }: { next: (opts: { sendContext: unknown }) => unknown; sendContext: unknown }) => {
        return next({ sendContext: { ...(sendContext as Record<string, unknown>), pool: null, keyring: null } });
      },
      server: async ({ next, context }: { next: (opts: { context: unknown }) => unknown; context: unknown }) => {
        return next({ context: { ...(context as Record<string, unknown>), pool: null, keyring: null } });
      },
    },
  },
  resetStackSecretsMiddlewareState: () => {},
}));

const mockGetStackSummaries = mock(() => Promise.resolve([
  { name: 'nginx', status: 'running', host: 'server1', lastDeployed: '2026-01-01T00:00:00Z' },
]));
const mockGetStackDetailByName = mock(() => Promise.resolve({
  name: 'nginx',
  composeContent: 'version: "3"',
  variables: {},
}));
const mockTriggerStackDeploy = mock(() => Promise.resolve({ deployId: 42, status: 'succeeded' as const, logs: 'deployed ok' }));
const mockGetStackDeployHistory = mock(() => Promise.resolve([
  { id: 1, stack: 'nginx', action: 'deploy', status: 'success', timestamp: '2026-01-01T00:00:00Z' },
]));
const mockSaveStackComposeFile = mock(() => Promise.resolve({ commitSha: 'abc123' }));
const mockUpdateStackIconSlug = mock(() => Promise.resolve(undefined));
const mockCreateStackInRepo = mock(() => Promise.resolve({ commitSha: 'abc123' }));
const mockDeleteStackFromRepo = mock((): Promise<{ status: 'removed'; commitSha: string } | { status: 'teardown-pending'; deployId: number }> =>
  Promise.resolve({ status: 'removed' as const, commitSha: 'abc123' }),
);
const mockGetManagedHostNames = mock(() => Promise.resolve(['server1']));
const mockResolveDeleteStack = mock(() =>
  Promise.resolve({ status: 'removed' as const, commitSha: 'abc123' }),
);
const mockResumePendingDeploy = mock(() => Promise.resolve({ deployId: 7, status: 'succeeded' as const, logs: 'ok' }));
const mockRejectPendingDeploy = mock(() => Promise.resolve({ deployId: 7 }));
const mockControlStackForHost = mock(() => Promise.resolve(undefined));

mock.module('@/lib/stacks/stack-service', () => ({
  getStackSummaries: mockGetStackSummaries,
  getStackDetailByName: mockGetStackDetailByName,
  triggerStackDeploy: mockTriggerStackDeploy,
  getStackDeployHistory: mockGetStackDeployHistory,
  saveStackComposeFile: mockSaveStackComposeFile,
  updateStackIconSlug: mockUpdateStackIconSlug,
  createStackInRepo: mockCreateStackInRepo,
  deleteStackFromRepo: mockDeleteStackFromRepo,
  getManagedHostNames: mockGetManagedHostNames,
  resolveDeleteStack: mockResolveDeleteStack,
  resumePendingDeploy: mockResumePendingDeploy,
  rejectPendingDeploy: mockRejectPendingDeploy,
  controlStackForHost: mockControlStackForHost,
}));

/**
 * Server function tests for stack management.
 *
 * Mocks the stack-service module to avoid database/git dependencies.
 * Tests exports and handler delegation to the stack-service layer.
 *
 * Note: createServerFn() handlers run in test context but the wrapper
 * does not return handler results. Input validation (zod schemas) is
 * applied by the framework at the network boundary, not in direct calls.
 * We verify delegation by asserting mock call counts and arguments.
 */
describe('stacks.functions module', () => {
  beforeEach(() => {
    mockGetStackSummaries.mockClear();
    mockGetStackDetailByName.mockClear();
    mockTriggerStackDeploy.mockClear();
    mockGetStackDeployHistory.mockClear();
    mockSaveStackComposeFile.mockClear();
    mockUpdateStackIconSlug.mockClear();
    mockCreateStackInRepo.mockClear();
    mockDeleteStackFromRepo.mockClear();
    mockGetManagedHostNames.mockClear();
    mockResolveDeleteStack.mockClear();
    mockResumePendingDeploy.mockClear();
    mockRejectPendingDeploy.mockClear();
    mockControlStackForHost.mockClear();
  });

  describe('exports', () => {
    it('exports listStacks server function', async () => {
      const mod = await import('../functions');
      expect(mod.listStacks).toBeDefined();
      expect(typeof mod.listStacks).toBe('function');
    });

    it('exports getStackDetail server function', async () => {
      const mod = await import('../functions');
      expect(mod.getStackDetail).toBeDefined();
      expect(typeof mod.getStackDetail).toBe('function');
    });

    it('exports triggerDeploy server function', async () => {
      const mod = await import('../functions');
      expect(mod.triggerDeploy).toBeDefined();
      expect(typeof mod.triggerDeploy).toBe('function');
    });

    it('exports getDeployHistory server function', async () => {
      const mod = await import('../functions');
      expect(mod.getDeployHistory).toBeDefined();
      expect(typeof mod.getDeployHistory).toBe('function');
    });

    it('exports saveComposeFile server function', async () => {
      const mod = await import('../functions');
      expect(mod.saveComposeFile).toBeDefined();
      expect(typeof mod.saveComposeFile).toBe('function');
    });

    it('exports updateStackIcon server function', async () => {
      const mod = await import('../functions');
      expect(mod.updateStackIcon).toBeDefined();
      expect(typeof mod.updateStackIcon).toBe('function');
    });

    it('exports controlStack server function', async () => {
      const mod = await import('../functions');
      expect(mod.controlStack).toBeDefined();
      expect(typeof mod.controlStack).toBe('function');
    });
  });

  describe('listStacks', () => {
    it('delegates to getStackSummaries', async () => {
      const { listStacks } = await import('../functions');
      await withStartContext(() => listStacks({}));
      expect(mockGetStackSummaries).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStackDetail', () => {
    it('delegates to getStackDetailByName with stackName', async () => {
      const { getStackDetail } = await import('../functions');
      await withStartContext(() => getStackDetail({ data: { stackName: 'nginx' } }));
      expect(mockGetStackDetailByName).toHaveBeenCalledTimes(1);
      expect(mockGetStackDetailByName).toHaveBeenCalledWith('nginx');
    });

    it('passes through different stack names', async () => {
      const { getStackDetail } = await import('../functions');
      await withStartContext(() => getStackDetail({ data: { stackName: 'redis' } }));
      expect(mockGetStackDetailByName).toHaveBeenCalledWith('redis');
    });
  });

  describe('triggerDeploy', () => {
    it('delegates to triggerStackDeploy with deploy action', async () => {
      const { triggerDeploy } = await import('../functions');
      await withStartContext(() =>
        triggerDeploy({
          data: { stack: 'nginx', host: 'server1', action: 'deploy' },
        }),
      );
      expect(mockTriggerStackDeploy).toHaveBeenCalledTimes(1);
      expect(mockTriggerStackDeploy).toHaveBeenCalledWith({
        stack: 'nginx',
        host: 'server1',
        action: 'deploy',
      });
    });

    it('delegates with teardown action', async () => {
      const { triggerDeploy } = await import('../functions');
      await withStartContext(() =>
        triggerDeploy({
          data: { stack: 'nginx', host: 'server1', action: 'teardown' },
        }),
      );
      expect(mockTriggerStackDeploy).toHaveBeenCalledWith({
        stack: 'nginx',
        host: 'server1',
        action: 'teardown',
      });
    });

  });

  describe('controlStack', () => {
    it('delegates start action for stack scope', async () => {
      const { controlStack } = await import('../functions');
      await withStartContext(() =>
        controlStack({
          data: { stack: 'nginx', host: 'server1', action: 'start', scope: 'stack' },
        }),
      );
      expect(mockControlStackForHost).toHaveBeenCalledTimes(1);
      expect(mockControlStackForHost).toHaveBeenCalledWith(
        'server1',
        'start',
        { stack: 'nginx', scope: 'stack' },
      );
    });

    it('delegates stop action for service scope', async () => {
      const { controlStack } = await import('../functions');
      await withStartContext(() =>
        controlStack({
          data: { stack: 'nginx', host: 'server1', action: 'stop', scope: 'service', service: 'web' },
        }),
      );
      expect(mockControlStackForHost).toHaveBeenCalledWith(
        'server1',
        'stop',
        { stack: 'nginx', scope: 'service', service: 'web' },
      );
    });

    it('delegates restart action for stack scope', async () => {
      const { controlStack } = await import('../functions');
      await withStartContext(() =>
        controlStack({
          data: { stack: 'myapp', host: 'host2', action: 'restart', scope: 'stack' },
        }),
      );
      expect(mockControlStackForHost).toHaveBeenCalledWith(
        'host2',
        'restart',
        { stack: 'myapp', scope: 'stack' },
      );
    });

    it('propagates error from controlStackForHost', async () => {
      mockControlStackForHost.mockRejectedValueOnce(new Error('agent unreachable'));
      const { controlStack } = await import('../functions');
      await expect(
        withStartContext(() =>
          controlStack({ data: { stack: 'nginx', host: 'server1', action: 'start', scope: 'stack' } }),
        )
      ).rejects.toThrow('agent unreachable');
    });
  });

  describe('getDeployHistory', () => {
    it('delegates to getStackDeployHistory with stackName and limit', async () => {
      const { getDeployHistory } = await import('../functions');
      await withStartContext(() => getDeployHistory({ data: { stackName: 'nginx', limit: 50 } }));
      expect(mockGetStackDeployHistory).toHaveBeenCalledTimes(1);
      expect(mockGetStackDeployHistory).toHaveBeenCalledWith('nginx', 50);
    });

    it('passes through stackName correctly', async () => {
      const { getDeployHistory } = await import('../functions');
      await withStartContext(() => getDeployHistory({ data: { stackName: 'postgres', limit: 10 } }));
      expect(mockGetStackDeployHistory).toHaveBeenCalledWith('postgres', 10);
    });
  });

  describe('saveComposeFile', () => {
    it('delegates to saveStackComposeFile with stackName and content', async () => {
      const { saveComposeFile } = await import('../functions');
      await withStartContext(() =>
        saveComposeFile({
          data: { stackName: 'nginx', content: 'version: "3.8"' },
        }),
      );
      expect(mockSaveStackComposeFile).toHaveBeenCalledTimes(1);
      expect(mockSaveStackComposeFile).toHaveBeenCalledWith('nginx', 'version: "3.8"');
    });

    it('handles empty content string', async () => {
      const { saveComposeFile } = await import('../functions');
      await withStartContext(() => saveComposeFile({ data: { stackName: 'nginx', content: '' } }));
      expect(mockSaveStackComposeFile).toHaveBeenCalledWith('nginx', '');
    });
  });

  describe('updateStackIcon', () => {
    it('delegates to updateStackIconSlug with stackName and iconSlug', async () => {
      const { updateStackIcon } = await import('../functions');
      await withStartContext(() => updateStackIcon({ data: { stackName: 'nginx', iconSlug: 'nginx' } }));
      expect(mockUpdateStackIconSlug).toHaveBeenCalledTimes(1);
      expect(mockUpdateStackIconSlug).toHaveBeenCalledWith('nginx', 'nginx');
    });

    it('passes through different icon slugs', async () => {
      const { updateStackIcon } = await import('../functions');
      await withStartContext(() => updateStackIcon({ data: { stackName: 'redis', iconSlug: 'redis-stack' } }));
      expect(mockUpdateStackIconSlug).toHaveBeenCalledWith('redis', 'redis-stack');
    });
  });

  describe('resumeDeploy', () => {
    it('delegates to resumePendingDeploy with deployId', async () => {
      const { resumeDeploy } = await import('../functions');
      await withStartContext(() => resumeDeploy({ data: { deployId: 42 } }));
      expect(mockResumePendingDeploy).toHaveBeenCalledTimes(1);
      expect(mockResumePendingDeploy).toHaveBeenCalledWith(42);
    });

    it('propagates service errors (e.g. non-pending status)', async () => {
      mockResumePendingDeploy.mockImplementationOnce(() =>
        Promise.reject(new Error('Deploy is not pending (status: succeeded)'))
      );
      const { resumeDeploy } = await import('../functions');
      await expect(withStartContext(() => resumeDeploy({ data: { deployId: 42 } }))).rejects.toThrow(
        'Deploy is not pending (status: succeeded)'
      );
    });

    it('propagates service errors when deploy is missing', async () => {
      mockResumePendingDeploy.mockImplementationOnce(() =>
        Promise.reject(new Error('Deploy 999 not found'))
      );
      const { resumeDeploy } = await import('../functions');
      await expect(withStartContext(() => resumeDeploy({ data: { deployId: 999 } }))).rejects.toThrow(
        'Deploy 999 not found'
      );
    });
  });

  describe('rejectDeploy', () => {
    it('delegates to rejectPendingDeploy with deployId', async () => {
      const { rejectDeploy } = await import('../functions');
      await withStartContext(() => rejectDeploy({ data: { deployId: 42 } }));
      expect(mockRejectPendingDeploy).toHaveBeenCalledTimes(1);
      expect(mockRejectPendingDeploy).toHaveBeenCalledWith(42);
    });

    it('propagates service errors (e.g. non-pending status)', async () => {
      mockRejectPendingDeploy.mockImplementationOnce(() =>
        Promise.reject(new Error('Deploy is not pending (status: in_progress)'))
      );
      const { rejectDeploy } = await import('../functions');
      await expect(withStartContext(() => rejectDeploy({ data: { deployId: 42 } }))).rejects.toThrow(
        'Deploy is not pending (status: in_progress)'
      );
    });

    it('propagates service errors when deploy is missing', async () => {
      mockRejectPendingDeploy.mockImplementationOnce(() =>
        Promise.reject(new Error('Deploy 999 not found'))
      );
      const { rejectDeploy } = await import('../functions');
      await expect(withStartContext(() => rejectDeploy({ data: { deployId: 999 } }))).rejects.toThrow(
        'Deploy 999 not found'
      );
    });
  });

  describe('deleteStack', () => {
    it('delegates to deleteStackFromRepo with teardown=true and returns teardown-pending', async () => {
      mockDeleteStackFromRepo.mockImplementationOnce(() =>
        Promise.resolve({ status: 'teardown-pending' as const, deployId: 42 }),
      );
      const { deleteStack } = await import('../functions');
      await withStartContext(() => deleteStack({ data: { stackName: 'nginx', teardown: true } }));
      expect(mockDeleteStackFromRepo).toHaveBeenCalledWith('nginx', true);
    });
  });

  describe('service error propagation', () => {
    it('listStacks propagates service errors', async () => {
      mockGetStackSummaries.mockImplementationOnce(() =>
        Promise.reject(new Error('Database connection failed'))
      );
      const { listStacks } = await import('../functions');
      await expect(withStartContext(() => listStacks({}))).rejects.toThrow('Database connection failed');
    });

    it('getStackDetail propagates service errors', async () => {
      mockGetStackDetailByName.mockImplementationOnce(() =>
        Promise.reject(new Error('Git repo not found'))
      );
      const { getStackDetail } = await import('../functions');
      await expect(
        withStartContext(() => getStackDetail({ data: { stackName: 'missing' } }))
      ).rejects.toThrow('Git repo not found');
    });

    it('triggerDeploy propagates service errors', async () => {
      mockTriggerStackDeploy.mockImplementationOnce(() =>
        Promise.reject(new Error('Agent unreachable'))
      );
      const { triggerDeploy } = await import('../functions');
      await expect(
        withStartContext(() => triggerDeploy({ data: { stack: 'nginx', host: 'server1', action: 'deploy' } }))
      ).rejects.toThrow('Agent unreachable');
    });

    it('saveComposeFile propagates service errors', async () => {
      mockSaveStackComposeFile.mockImplementationOnce(() =>
        Promise.reject(new Error('Commit failed'))
      );
      const { saveComposeFile } = await import('../functions');
      await expect(
        withStartContext(() => saveComposeFile({ data: { stackName: 'nginx', content: 'bad' } }))
      ).rejects.toThrow('Commit failed');
    });

    it('updateStackIcon propagates service errors', async () => {
      mockUpdateStackIconSlug.mockImplementationOnce(() =>
        Promise.reject(new Error('Entity not found'))
      );
      const { updateStackIcon } = await import('../functions');
      await expect(
        withStartContext(() => updateStackIcon({ data: { stackName: 'nginx', iconSlug: 'bad' } }))
      ).rejects.toThrow('Entity not found');
    });

    it('getDeployHistory propagates service errors', async () => {
      mockGetStackDeployHistory.mockImplementationOnce(() =>
        Promise.reject(new Error('Query timeout'))
      );
      const { getDeployHistory } = await import('../functions');
      await expect(
        withStartContext(() => getDeployHistory({ data: { stackName: 'nginx', limit: 10 } }))
      ).rejects.toThrow('Query timeout');
    });
  });
});

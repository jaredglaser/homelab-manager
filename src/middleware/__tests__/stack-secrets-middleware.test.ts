import { describe, test, expect, spyOn, mock, beforeEach, afterEach } from 'bun:test';
import type { Pool } from 'pg';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import { databaseConnectionManager } from '@/lib/clients/database-client';
import { resetStackSecretsMiddlewareState } from '@/middleware/stack-secrets-middleware';

const fakeKeyring: MasterKeyring = { activeKid: 'v1', keys: new Map() };
const mockLoadMasterKeyring = mock(() => Promise.resolve(fakeKeyring));

mock.module('@/lib/crypto/master-key', () => ({
  loadMasterKeyring: mockLoadMasterKeyring,
}));

describe('stackSecretsMiddleware', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetStackSecretsMiddlewareState();
    mockLoadMasterKeyring.mockClear();
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    resetStackSecretsMiddlewareState();
    consoleErrorSpy.mockRestore();
  });

  test('middleware options have server handler defined', async () => {
    const { stackSecretsMiddleware } = await import('@/middleware/stack-secrets-middleware');
    expect(stackSecretsMiddleware.options).toBeDefined();
    expect(stackSecretsMiddleware.options.server).toBeDefined();
    expect(typeof stackSecretsMiddleware.options.server).toBe('function');
  });

  test('injects pool and keyring into context via next()', async () => {
    const fakePool = { fake: 'pool' } as unknown as Pool;
    const getClientSpy = spyOn(databaseConnectionManager, 'getClient').mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { getPool: () => fakePool } as any,
    );

    try {
      const { stackSecretsMiddleware } = await import('@/middleware/stack-secrets-middleware');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const serverHandler = stackSecretsMiddleware.options.server as any;

      let capturedContext: Record<string, unknown> = {};
      const nextFn = mock(({ context }: { context: Record<string, unknown> }) => {
        capturedContext = context;
        return Promise.resolve();
      });

      await serverHandler({ next: nextFn });

      expect(nextFn).toHaveBeenCalledTimes(1);
      expect(capturedContext.pool).toBe(fakePool);
      expect(capturedContext.keyring).toBe(fakeKeyring);
      expect(getClientSpy).toHaveBeenCalled();
      expect(mockLoadMasterKeyring).toHaveBeenCalledTimes(1);
    } finally {
      getClientSpy.mockRestore();
    }
  });

  test('rejects and does not call next() when getClient fails', async () => {
    const bootstrapError = new Error('connect ECONNREFUSED');
    const getClientSpy = spyOn(databaseConnectionManager, 'getClient').mockRejectedValue(
      bootstrapError,
    );

    try {
      const { stackSecretsMiddleware } = await import('@/middleware/stack-secrets-middleware');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const serverHandler = stackSecretsMiddleware.options.server as any;
      const nextFn = mock();

      await expect(serverHandler({ next: nextFn })).rejects.toThrow('connect ECONNREFUSED');
      expect(nextFn).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[stackSecretsMiddleware] Bootstrap failed:',
        bootstrapError,
      );
    } finally {
      getClientSpy.mockRestore();
    }
  });

  test('rejects and does not call next() when loadMasterKeyring fails', async () => {
    const fakePool = { fake: 'pool' } as unknown as Pool;
    const getClientSpy = spyOn(databaseConnectionManager, 'getClient').mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { getPool: () => fakePool } as any,
    );
    const keyringError = new Error('MASTER_KEY not set');
    mockLoadMasterKeyring.mockImplementationOnce(() => Promise.reject(keyringError));

    try {
      const { stackSecretsMiddleware } = await import('@/middleware/stack-secrets-middleware');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const serverHandler = stackSecretsMiddleware.options.server as any;
      const nextFn = mock();

      await expect(serverHandler({ next: nextFn })).rejects.toThrow('MASTER_KEY not set');
      expect(nextFn).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[stackSecretsMiddleware] Bootstrap failed:',
        keyringError,
      );
    } finally {
      getClientSpy.mockRestore();
    }
  });

  test('loads config and keyring once and reuses across requests', async () => {
    const fakePool = { fake: 'pool' } as unknown as Pool;
    const getClientSpy = spyOn(databaseConnectionManager, 'getClient').mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { getPool: () => fakePool } as any,
    );

    try {
      const { stackSecretsMiddleware } = await import('@/middleware/stack-secrets-middleware');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const serverHandler = stackSecretsMiddleware.options.server as any;

      await serverHandler({ next: mock(() => Promise.resolve()) });
      await serverHandler({ next: mock(() => Promise.resolve()) });

      // Same config object passed to getClient on both invocations.
      expect(getClientSpy).toHaveBeenCalledTimes(2);
      expect(getClientSpy.mock.calls[0][0]).toBe(getClientSpy.mock.calls[1][0]);
      // Keyring loaded only once despite two requests.
      expect(mockLoadMasterKeyring).toHaveBeenCalledTimes(1);
    } finally {
      getClientSpy.mockRestore();
    }
  });
});

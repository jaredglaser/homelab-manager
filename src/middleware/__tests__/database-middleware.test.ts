import { describe, expect, test, spyOn, mock, beforeEach, afterEach } from 'bun:test';
import type { Pool } from 'pg';
import { databaseConnectionManager } from '@/lib/clients/database-client';
import { resetDatabaseMiddlewareState } from '@/middleware/database-middleware';

describe('databaseMiddleware', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetDatabaseMiddlewareState();
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    resetDatabaseMiddlewareState();
    consoleErrorSpy.mockRestore();
  });

  test('middleware options have server handler defined', async () => {
    const { databaseMiddleware } = await import(
      '@/middleware/database-middleware'
    );

    expect(databaseMiddleware.options).toBeDefined();
    expect(databaseMiddleware.options.server).toBeDefined();
    expect(typeof databaseMiddleware.options.server).toBe('function');
  });

  test('injects pool into context via next()', async () => {
    const fakePool = { fake: 'pool' } as unknown as Pool;
    // Spy on the singleton getClient so the middleware uses a fake DatabaseClient
    // without actually connecting to PostgreSQL.
    const getClientSpy = spyOn(databaseConnectionManager, 'getClient').mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { getPool: () => fakePool } as any,
    );

    try {
      const { databaseMiddleware } = await import(
        '@/middleware/database-middleware'
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const serverHandler = databaseMiddleware.options.server as any;

      let capturedContext: Record<string, unknown> = {};
      const nextFn = mock(({ context }: { context: Record<string, unknown> }) => {
        capturedContext = context;
        return Promise.resolve();
      });

      await serverHandler({ next: nextFn });

      expect(nextFn).toHaveBeenCalledTimes(1);
      expect(capturedContext.pool).toBe(fakePool);
      expect(Object.keys(capturedContext)).toEqual(['pool']);
      expect(getClientSpy).toHaveBeenCalled();
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
      const { databaseMiddleware } = await import(
        '@/middleware/database-middleware'
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const serverHandler = databaseMiddleware.options.server as any;
      const nextFn = mock();

      await expect(serverHandler({ next: nextFn })).rejects.toThrow(
        'connect ECONNREFUSED',
      );
      expect(nextFn).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[databaseMiddleware] DB bootstrap failed:',
        bootstrapError,
      );
    } finally {
      getClientSpy.mockRestore();
    }
  });

  test('loads config once and reuses it across requests', async () => {
    const fakePool = { fake: 'pool' } as unknown as Pool;
    const getClientSpy = spyOn(databaseConnectionManager, 'getClient').mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { getPool: () => fakePool } as any,
    );

    try {
      const { databaseMiddleware } = await import(
        '@/middleware/database-middleware'
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const serverHandler = databaseMiddleware.options.server as any;

      await serverHandler({ next: mock(() => Promise.resolve()) });
      await serverHandler({ next: mock(() => Promise.resolve()) });

      // Same config object passed to getClient on both invocations — proves the
      // module-scoped cache, not a re-load per request.
      expect(getClientSpy).toHaveBeenCalledTimes(2);
      expect(getClientSpy.mock.calls[0][0]).toBe(getClientSpy.mock.calls[1][0]);
    } finally {
      getClientSpy.mockRestore();
    }
  });
});

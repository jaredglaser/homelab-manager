import { describe, expect, test, spyOn } from 'bun:test';
import type { Pool } from 'pg';
import { databaseConnectionManager } from '@/lib/clients/database-client';

describe('databaseMiddleware', () => {
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
      let nextCallCount = 0;
      const nextFn = ({ context }: { context: Record<string, unknown> }) => {
        capturedContext = context;
        nextCallCount++;
        return Promise.resolve();
      };

      await serverHandler({ next: nextFn });

      expect(nextCallCount).toBe(1);
      expect(capturedContext.pool).toBe(fakePool);
      expect(getClientSpy).toHaveBeenCalled();
    } finally {
      getClientSpy.mockRestore();
    }
  });
});

import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { resetOpenBaoInitState } from '@/lib/services/openbao-init';

describe('openBaoMiddleware', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetOpenBaoInitState();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    resetOpenBaoInitState();
  });

  test('throws when OpenBao is not configured', async () => {
    delete process.env.OPENBAO_URL;
    delete process.env.OPENBAO_TOKEN;

    const { openBaoMiddleware } = await import(
      '@/middleware/openbao-middleware'
    );

    // Access the raw server handler from the middleware options
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serverHandler = openBaoMiddleware.options.server as any;
    const nextFn = mock();

    await expect(
      serverHandler({ next: nextFn }),
    ).rejects.toThrow('OpenBao is not configured');

    expect(nextFn).not.toHaveBeenCalled();
  });

  test('throws when only OPENBAO_URL is set without token', async () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    delete process.env.OPENBAO_TOKEN;

    const { openBaoMiddleware } = await import(
      '@/middleware/openbao-middleware'
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serverHandler = openBaoMiddleware.options.server as any;
    const nextFn = mock();

    await expect(
      serverHandler({ next: nextFn }),
    ).rejects.toThrow('OpenBao is not configured');

    expect(nextFn).not.toHaveBeenCalled();
  });

  test('creates client and calls next with openBaoClient in context when configured', async () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    // Mock fetch so ensureSecretsEngine succeeds (engine already mounted)
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            'secret/': { type: 'kv', options: { version: '2' } },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const { openBaoMiddleware } = await import(
      '@/middleware/openbao-middleware'
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serverHandler = openBaoMiddleware.options.server as any;
    let capturedContext: Record<string, unknown> = {};
    const nextFn = mock(({ context }: { context: Record<string, unknown> }) => {
      capturedContext = context;
      return Promise.resolve();
    });

    await serverHandler({ next: nextFn });

    expect(nextFn).toHaveBeenCalledTimes(1);
    expect(capturedContext.openBaoClient).toBeDefined();
  });

  test('middleware options have server handler defined', async () => {
    const { openBaoMiddleware } = await import(
      '@/middleware/openbao-middleware'
    );

    expect(openBaoMiddleware.options).toBeDefined();
    expect(openBaoMiddleware.options.server).toBeDefined();
    expect(typeof openBaoMiddleware.options.server).toBe('function');
  });
});

import { describe, expect, it, spyOn, beforeEach, afterEach } from 'bun:test';
import { createMiddleware } from '@tanstack/react-start';
import { executeMiddleware } from '@tanstack/start-client-core';
import { z } from 'zod';
import { withStartContext } from '@/lib/test/start-context';
import { invalidInputMiddleware } from '@/middleware/invalid-input-middleware';
import { INVALID_INPUT_MESSAGE } from '@/lib/errors/invalid-input-copy';
import { createPendingHostSchema } from '@/data/hosts/schemas';
import { startInstance } from '@/start';

type AnyMiddleware = Parameters<typeof executeMiddleware>[0][number];

// Runs the real server-side middleware chain, so the validator rejection is the one the framework itself produces.
async function runOnServer(middlewares: unknown[], data: unknown): Promise<{ error?: unknown; result?: unknown }> {
  return withStartContext(() =>
    executeMiddleware(middlewares as AnyMiddleware[], 'server', { data } as Parameters<typeof executeMiddleware>[2]),
  ) as Promise<{ error?: unknown; result?: unknown }>;
}

describe('invalidInputMiddleware', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('replaces the issue JSON of a failed validator with user copy', async () => {
    const validated = createMiddleware({ type: 'function' }).validator(createPendingHostSchema);

    const withoutIt = await runOnServer([validated], { name: 'my host' });
    expect((withoutIt.error as Error).message.trimStart().startsWith('[')).toBe(true);

    const outcome = await runOnServer([invalidInputMiddleware, validated], { name: 'my host' });
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toBe(INVALID_INPUT_MESSAGE);
  });

  it('logs which fields were rejected', async () => {
    const validated = createMiddleware({ type: 'function' }).validator(createPendingHostSchema);
    await runOnServer([invalidInputMiddleware, validated], { name: 'my host' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][1])).toContain('name: Use only letters, numbers, hyphens and underscores.');
  });

  it('lets a valid call through', async () => {
    const validated = createMiddleware({ type: 'function' })
      .validator(z.object({ name: z.string() }))
      .server(({ next, data }) => next({ context: { seen: data.name } }));
    const outcome = await runOnServer([invalidInputMiddleware, validated], { name: 'dev-box' });
    expect(outcome.error).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('passes any other failure through unchanged', async () => {
    const failure = new Error('A host named dev-box already exists');
    const failing = createMiddleware({ type: 'function' }).server(() => {
      throw failure;
    });
    const outcome = await runOnServer([invalidInputMiddleware, failing], {});
    expect(outcome.error).toBe(failure);
  });

  it('is registered for every server function', async () => {
    const options = await startInstance.getOptions();
    expect(options.functionMiddleware).toContain(invalidInputMiddleware);
  });
});

import { describe, expect, it, spyOn, beforeEach, afterEach } from 'bun:test';
import { createMiddleware } from '@tanstack/react-start';
import { executeMiddleware } from '@tanstack/start-client-core';
import { defaultSerovalPlugins, makeSerovalPlugin } from '@tanstack/router-core/ssr/client';
import { fromCrossJSON, toCrossJSONAsync } from 'seroval';
import { z } from 'zod';
import { withStartContext } from '@/lib/test/start-context';
import { invalidInputMiddleware } from '@/middleware/invalid-input-middleware';
import { TaggedServerError, taggedServerErrorAdapter } from '@/lib/errors/tagged-server-error';
import { createPendingHostSchema } from '@/data/hosts/schemas';
import { startInstance } from '@/start';

type AnyMiddleware = Parameters<typeof executeMiddleware>[0][number];

// Runs the real server-side middleware chain, so the validator rejection is the one the framework itself produces.
async function runOnServer(middlewares: unknown[], data: unknown): Promise<{ error?: unknown; result?: unknown }> {
  return withStartContext(() =>
    executeMiddleware(middlewares as AnyMiddleware[], 'server', { data } as Parameters<typeof executeMiddleware>[2]),
  ) as Promise<{ error?: unknown; result?: unknown }>;
}

const wirePlugins = [makeSerovalPlugin(taggedServerErrorAdapter), ...defaultSerovalPlugins];

describe('invalidInputMiddleware', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('replaces the issue JSON of a failed validator with a tagged sentence that names the field', async () => {
    const validated = createMiddleware({ type: 'function' }).validator(createPendingHostSchema);

    const withoutIt = await runOnServer([validated], { name: 'my host' });
    expect((withoutIt.error as Error).message.trimStart().startsWith('[')).toBe(true);

    const outcome = await runOnServer([invalidInputMiddleware, validated], { name: 'my host' });
    expect(outcome.error).toBeInstanceOf(TaggedServerError);
    expect(outcome.error).toMatchObject({
      code: 'invalid_input',
      field: 'name',
      message: 'The value for "name" was not accepted. Check it and try again.',
    });
  });

  it('sends a direct caller the sentence and the tag, never the issue list', async () => {
    const validated = createMiddleware({ type: 'function' }).validator(createPendingHostSchema);
    const outcome = await runOnServer([invalidInputMiddleware, validated], { name: 'my host' });

    const body = JSON.stringify(await toCrossJSONAsync({ error: outcome.error }, { refs: new Map(), plugins: wirePlugins }));
    expect(body).toContain('was not accepted. Check it and try again.');
    expect(body).toContain('invalid_input');
    expect(body).not.toContain('invalid_format');
    expect(body).not.toContain('Spaces are not allowed');

    const received = (fromCrossJSON(JSON.parse(body), { refs: new Map(), plugins: wirePlugins }) as { error: unknown }).error;
    expect(received).toBeInstanceOf(TaggedServerError);
    expect(received).toMatchObject({
      code: 'invalid_input',
      field: 'name',
      message: 'The value for "name" was not accepted. Check it and try again.',
    });
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

  it('passes any other failure through unchanged, so a sign-in error ahead of the validator wins', async () => {
    const failure = new Error('Unauthorized');
    const failing = createMiddleware({ type: 'function' }).server(() => {
      throw failure;
    });
    const validated = createMiddleware({ type: 'function' }).validator(createPendingHostSchema);
    const outcome = await runOnServer([invalidInputMiddleware, failing, validated], { name: 'my host' });
    expect(outcome.error).toBe(failure);
  });

  it('is registered for every server function, with the adapter that carries its tag to the browser', async () => {
    const options = await startInstance.getOptions();
    expect(options.functionMiddleware).toContain(invalidInputMiddleware);
    expect(options.serializationAdapters).toContain(taggedServerErrorAdapter);
  });
});

import { describe, it, expect, spyOn } from 'bun:test';
import { toJSONAsync, fromCrossJSON } from 'seroval';
import { defaultSerovalPlugins } from '@tanstack/router-core';

import { handleServerFn } from '@/lib/mock/handlers/server-functions';
import { encodeFunctionId } from '@/lib/mock/handlers/function-id';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import type { DockerStatsRow } from '@/types/docker';

function serverFnUrl(name: string): string {
  return `http://localhost/_serverFn/${encodeFunctionId('/f.tsx', name)}`;
}

/** Decode the `{ result, error }` envelope the way the TanStack client does. */
async function decodeEnvelope(res: Response): Promise<{ result: unknown; error: unknown }> {
  return fromCrossJSON(await res.json(), {
    refs: new Map(),
    plugins: defaultSerovalPlugins,
  }) as { result: unknown; error: unknown };
}

async function decodeResult(res: Response): Promise<unknown> {
  return (await decodeEnvelope(res)).result;
}

async function encodePayload(payload: { data?: unknown; context?: unknown }): Promise<string> {
  return JSON.stringify(await toJSONAsync(payload, { plugins: defaultSerovalPlugins }));
}

type OverrideHost = typeof globalThis & {
  __mockServerFnOverrides?: Record<string, unknown>;
};

function setOverrides(overrides: Record<string, unknown>): void {
  (globalThis as OverrideHost).__mockServerFnOverrides = overrides;
}

function clearOverrides(): void {
  delete (globalThis as OverrideHost).__mockServerFnOverrides;
}

async function callGet(
  name: string,
  payload?: { data?: unknown; context?: unknown },
): Promise<Response> {
  let url = serverFnUrl(name);
  if (payload) {
    url += `?payload=${encodeURIComponent(await encodePayload(payload))}`;
  }
  return handleServerFn(new Request(url, { method: 'GET' }));
}

async function callPost(
  name: string,
  payload: { data?: unknown; context?: unknown },
): Promise<Response> {
  return handleServerFn(
    new Request(serverFnUrl(name), { method: 'POST', body: await encodePayload(payload) }),
  );
}

describe('handleServerFn', () => {
  it('responds in the real server format (json + x-tss-serialized envelope)', async () => {
    const res = await callGet('getSession');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-tss-serialized')).toBe('true');
  });

  it('dispatches a mapped no-arg function (getSession -> synthetic admin)', async () => {
    const res = await callGet('getSession');
    expect(await decodeResult(res)).toEqual(SYNTHETIC_ADMIN);
  });

  it('resolves the export name through the compiler handler suffix', async () => {
    const res = await callGet('getSession_createServerFn_handler');
    expect(await decodeResult(res)).toEqual(SYNTHETIC_ADMIN);
  });

  it('decodes the GET payload and passes data to the mock', async () => {
    const res = await callGet('getHistoricalDockerStats', { data: { seconds: 4 } });
    const rows = (await decodeResult(res)) as DockerStatsRow[];
    // One snapshot per requested second, inclusive of both endpoints.
    expect(new Set(rows.map((row) => row.time)).size).toBe(5);
  });

  it('decodes a POST body payload', async () => {
    const res = await callPost('getStackDetail', { data: { stackName: 'plex' } });
    const detail = (await decodeResult(res)) as { name: string };
    expect(detail.name).toBe('plex');
  });

  it('delivers a thrown ZodError as the envelope error instead of escaping', async () => {
    const res = await callPost('createGitToken', { data: { label: '' } });
    expect(res.headers.get('x-tss-serialized')).toBe('true');
    const { result, error } = await decodeEnvelope(res);
    expect(result).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('label');
  });

  it('answers a name from the window override, not from the registry mock', async () => {
    const session = { id: 7, email: 'op@example.com', name: 'Operator', role: 'operator' };
    setOverrides({ getSession: session });
    try {
      const res = await callGet('getSession');
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('x-tss-serialized')).toBe('true');
      const result = await decodeResult(res);
      expect(result).toEqual(session);
      expect(result).not.toEqual(SYNTHETIC_ADMIN);
    } finally {
      clearOverrides();
    }
  });

  it('falls through to the registry mock for a name with no override', async () => {
    setOverrides({ listStacks: [] });
    try {
      expect(await decodeResult(await callGet('getSession'))).toEqual(SYNTHETIC_ADMIN);
    } finally {
      clearOverrides();
    }
  });

  it('returns a null result and warns for an unmapped function', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await callGet('thisFunctionDoesNotExist');
      expect(await decodeResult(res)).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

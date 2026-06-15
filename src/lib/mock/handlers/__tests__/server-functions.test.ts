import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import { toJSONAsync, fromCrossJSON } from 'seroval';

import { handleServerFn } from '@/lib/mock/handlers/server-functions';
import { encodeFunctionId } from '@/lib/mock/handlers/function-id';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';

function serverFnUrl(name: string): string {
  return `http://localhost/_serverFn/${encodeFunctionId('/f.tsx', name)}`;
}

/** Decode the server's `{ result }` envelope the way the TanStack client does. */
async function decodeResult(res: Response): Promise<unknown> {
  const envelope = fromCrossJSON(await res.json(), { refs: new Map() }) as {
    result: unknown;
  };
  return envelope.result;
}

async function callGet(
  name: string,
  payload?: { data?: unknown; context?: unknown },
): Promise<Response> {
  let url = serverFnUrl(name);
  if (payload) {
    const serialized = JSON.stringify(await toJSONAsync(payload));
    url += `?payload=${encodeURIComponent(serialized)}`;
  }
  return handleServerFn(new Request(url, { method: 'GET' }));
}

describe('handleServerFn', () => {
  afterEach(() => {
    // Restore any console spies between tests.
  });

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
    const res = await callGet('getHistoricalDockerStats', { data: { seconds: 1 } });
    const result = await decodeResult(res);
    expect(Array.isArray(result)).toBe(true);
  });

  it('decodes a POST body payload', async () => {
    const serialized = JSON.stringify(
      await toJSONAsync({ data: { host: 'h', containerId: 'c', action: 'stop' } }),
    );
    const res = await handleServerFn(
      new Request(serverFnUrl('controlContainer'), {
        method: 'POST',
        body: serialized,
      }),
    );
    // controlContainer is a no-op mock: void result.
    expect(await decodeResult(res)).toBeUndefined();
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

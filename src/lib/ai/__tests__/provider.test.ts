import { describe, it, expect, mock } from 'bun:test';
import { buildModels, normalizeBaseUrl, probeEndpoint } from '@/lib/ai/provider';

describe('normalizeBaseUrl', () => {
  it('appends /v1 when the URL has no version segment', () => {
    expect(normalizeBaseUrl('http://gpu-box:8080')).toBe('http://gpu-box:8080/v1');
  });

  it('leaves an existing version segment alone', () => {
    expect(normalizeBaseUrl('http://gpu-box:8080/v1')).toBe('http://gpu-box:8080/v1');
    expect(normalizeBaseUrl('http://gpu-box:8080/v2')).toBe('http://gpu-box:8080/v2');
  });

  it('strips trailing slashes and surrounding whitespace', () => {
    expect(normalizeBaseUrl('  http://gpu-box:8080/v1//  ')).toBe('http://gpu-box:8080/v1');
  });

  it('rejects an empty URL', () => {
    expect(() => normalizeBaseUrl('   ')).toThrow('AI base URL is empty');
  });
});

describe('buildModels', () => {
  it('defaults the profiler to the analyst model', () => {
    const models = buildModels({
      baseUrl: 'http://gpu-box:8080',
      model: 'analyst-8b',
      profilerModel: null,
      apiKey: null,
      maxContextTokens: 16_384,
    });
    expect(models.analystModelId).toBe('analyst-8b');
    expect(models.profilerModelId).toBe('analyst-8b');
    expect(models.maxContextTokens).toBe(16_384);
  });

  it('uses a distinct profiler model when one is configured', () => {
    const models = buildModels({
      baseUrl: 'http://gpu-box:8080/v1',
      model: 'analyst-8b',
      profilerModel: 'profiler-70b',
      apiKey: 'sk-test',
      maxContextTokens: 32_768,
    });
    expect(models.profilerModelId).toBe('profiler-70b');
    expect(models.analyst).not.toBe(models.profiler);
  });
});

describe('probeEndpoint', () => {
  it('returns the advertised model ids on success', async () => {
    const fetchFn = mock(async (_url: string, _init?: RequestInit) =>
      Response.json({ data: [{ id: 'a' }, { id: 'b' }, { id: 42 }] }),
    );
    const result = await probeEndpoint('http://gpu-box:8080', null, fetchFn as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, models: ['a', 'b'], error: null });
    expect(fetchFn.mock.calls[0][0]).toBe('http://gpu-box:8080/v1/models');
  });

  it('sends the bearer header only when a key is given', async () => {
    const fetchFn = mock(async (_url: string, _init?: RequestInit) => Response.json({ data: [] }));
    await probeEndpoint('http://gpu-box:8080', 'sk-test', fetchFn as unknown as typeof fetch);
    const init = fetchFn.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');

    const anonymous = mock(async (_url: string, _init?: RequestInit) => Response.json({ data: [] }));
    await probeEndpoint('http://gpu-box:8080', null, anonymous as unknown as typeof fetch);
    const anonInit = anonymous.mock.calls[0][1]!;
    expect(anonInit.headers).toEqual({});
  });

  it('tolerates a response with no data array', async () => {
    const fetchFn = mock(async (_url: string, _init?: RequestInit) => Response.json({}));
    const result = await probeEndpoint('http://gpu-box:8080', null, fetchFn as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, models: [], error: null });
  });

  it('reports a non-ok status', async () => {
    const fetchFn = mock(async (_url: string, _init?: RequestInit) => new Response('nope', { status: 503 }));
    const result = await probeEndpoint('http://gpu-box:8080', null, fetchFn as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, models: [], error: 'Endpoint returned 503' });
  });

  it('reports a network failure', async () => {
    const fetchFn = mock(async (_url: string, _init?: RequestInit) => {
      throw new Error('ECONNREFUSED');
    });
    const result = await probeEndpoint('http://gpu-box:8080', null, fetchFn as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });

  it('reports an unusable base URL without calling fetch', async () => {
    const fetchFn = mock(async (_url: string, _init?: RequestInit) => Response.json({}));
    const result = await probeEndpoint('  ', null, fetchFn as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('AI base URL is empty');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

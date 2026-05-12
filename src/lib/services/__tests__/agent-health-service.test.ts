import { describe, it, expect, mock } from 'bun:test';
import { checkAgentHealth } from '../agent-health-service';

// Use dependency injection (fetchFn parameter) instead of global fetch mock
// per CLAUDE.md rule 7: avoid globalThis mocks, use narrow-scope DI instead.

describe('agent-health-service', () => {
  describe('checkAgentHealth', () => {
    it('returns healthy result when agent responds with 200', async () => {
      const fetchFn = mock(async () =>
        new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.1.0',
            dockerVersion: '24.0.7',
            uptime: 3600,
          }),
          { status: 200 }
        )
      ) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result.healthy).toBe(true);
      if (result.healthy) {
        expect(result.version).toBe('0.1.0');
        expect(result.dockerVersion).toBe('24.0.7');
      }
    });

    it('returns unhealthy result when agent responds with non-200', async () => {
      const fetchFn = mock(async () =>
        new Response('Internal Server Error', { status: 500 })
      ) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toContain('500');
    });

    it('returns unhealthy result when fetch throws (network error)', async () => {
      const fetchFn = mock(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toContain('ECONNREFUSED');
    });

    it('calls the correct URL with /health path', async () => {
      let calledUrl = '';
      const fetchFn = mock(async (input: string | URL | Request) => {
        calledUrl = typeof input === 'string' ? input : input.toString();
        return new Response(
          JSON.stringify({ status: 'ok', version: '0.1.0' }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      await checkAgentHealth('http://agent:9090', undefined, fetchFn);
      expect(calledUrl).toBe('http://agent:9090/health');
    });

    it('uses a timeout via AbortSignal', async () => {
      const fetchFn = mock(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBeDefined();
        return new Response(
          JSON.stringify({ status: 'ok', version: '0.1.0' }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      await checkAgentHealth('http://agent:9090', undefined, fetchFn);
    });

    it('returns unhealthy on timeout (TimeoutError from AbortSignal.timeout)', async () => {
      const fetchFn = mock(async () => {
        const err = new Error('The operation timed out');
        err.name = 'TimeoutError';
        throw err;
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toContain('timed out');
    });

    it('returns unhealthy on manual abort (AbortError)', async () => {
      const fetchFn = mock(async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toContain('timed out');
    });

    it('returns unhealthy when agent returns 200 with non-JSON body', async () => {
      const fetchFn = mock(async () =>
        new Response('not valid json', { status: 200 })
      ) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toContain('non-JSON response');
    });

    it('returns unhealthy when agent URL returns a redirect (3xx)', async () => {
      const fetchFn = mock(async () =>
        new Response(null, { status: 301, headers: { Location: 'http://169.254.169.254/metadata' } })
      ) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toContain('redirect');
    });

    it('passes redirect: manual to fetch', async () => {
      let capturedInit: RequestInit | undefined;
      const fetchFn = mock(async (_input: string | URL | Request, init?: RequestInit) => {
        capturedInit = init;
        return new Response(
          JSON.stringify({ status: 'ok', version: '0.1.0' }),
          { status: 200 }
        );
      }) as unknown as typeof fetch;

      await checkAgentHealth('http://agent:9090', undefined, fetchFn);
      expect(capturedInit?.redirect).toBe('manual');
    });
  });

});

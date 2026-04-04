import { describe, it, expect, mock } from 'bun:test';
import { checkAgentHealth, verifyAgentToken } from '../agent-health-service';

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
  });

  describe('verifyAgentToken', () => {
    it('resolves when agent returns 200', async () => {
      const fetchFn = mock(async () =>
        new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
      ) as unknown as typeof fetch;

      await expect(verifyAgentToken('http://agent:9090', 'valid-token', undefined, fetchFn)).resolves.toBeUndefined();
    });

    it('sends Authorization header and calls /auth/verify', async () => {
      let calledUrl = '';
      let calledHeaders: Headers | undefined;
      const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
        calledUrl = typeof input === 'string' ? input : input.toString();
        calledHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }) as unknown as typeof fetch;

      await verifyAgentToken('http://agent:9090', 'my-token', undefined, fetchFn);

      expect(calledUrl).toBe('http://agent:9090/auth/verify');
      expect(calledHeaders?.get('Authorization')).toBe('Bearer my-token');
    });

    it('strips trailing slash from agent URL', async () => {
      let calledUrl = '';
      const fetchFn = mock(async (input: string | URL | Request) => {
        calledUrl = typeof input === 'string' ? input : input.toString();
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }) as unknown as typeof fetch;

      await verifyAgentToken('http://agent:9090/', 'tok', undefined, fetchFn);
      expect(calledUrl).toBe('http://agent:9090/auth/verify');
    });

    it('throws on 401 with clear message', async () => {
      const fetchFn = mock(async () =>
        new Response('Unauthorized', { status: 401 })
      ) as unknown as typeof fetch;

      await expect(
        verifyAgentToken('http://agent:9090', 'wrong-token', undefined, fetchFn)
      ).rejects.toThrow(/invalid.*agent rejected/i);
    });

    it('throws on non-200 non-401 response', async () => {
      const fetchFn = mock(async () =>
        new Response('Server Error', { status: 500 })
      ) as unknown as typeof fetch;

      await expect(
        verifyAgentToken('http://agent:9090', 'tok', undefined, fetchFn)
      ).rejects.toThrow(/status 500/);
    });

    it('throws on network error', async () => {
      const fetchFn = mock(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;

      await expect(
        verifyAgentToken('http://agent:9090', 'tok', undefined, fetchFn)
      ).rejects.toThrow(/ECONNREFUSED/);
    });
  });
});

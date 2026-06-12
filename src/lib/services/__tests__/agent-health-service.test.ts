import { describe, it, expect, mock } from 'bun:test';
import { checkAgentHealth } from '../agent-health-service';

// Use dependency injection (fetchFn parameter) instead of global fetch mock
// per CLAUDE.md rule 7: avoid globalThis mocks, use narrow-scope DI instead.

const healthBody = JSON.stringify({ status: 'healthy' });

function infoBody(agentVersion = '0.1.0', dockerVersion = '24.0.7'): string {
  return JSON.stringify({
    status: 'healthy',
    agentVersion,
    capabilities: {
      docker: { available: true, version: dockerVersion, apiVersion: '1.43' },
      zfs: { available: false },
    },
  });
}

describe('agent-health-service', () => {
  describe('checkAgentHealth', () => {
    it('returns healthy result when agent responds with 200', async () => {
      const fetchFn = mock(async () =>
        new Response(healthBody, { status: 200 })
      ) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result.healthy).toBe(true);
      if (result.healthy) {
        expect(result.version).toBeUndefined();
        expect(result.dockerVersion).toBeUndefined();
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
        return new Response(healthBody, { status: 200 });
      }) as unknown as typeof fetch;

      await checkAgentHealth('http://agent:9090', undefined, fetchFn);
      expect(calledUrl).toBe('http://agent:9090/health');
    });

    it('uses a timeout via AbortSignal', async () => {
      const fetchFn = mock(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBeDefined();
        return new Response(healthBody, { status: 200 });
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
        return new Response(healthBody, { status: 200 });
      }) as unknown as typeof fetch;

      await checkAgentHealth('http://agent:9090', undefined, fetchFn);
      expect(capturedInit?.redirect).toBe('manual');
    });
  });

  describe('checkAgentHealth with getToken (authenticated /info)', () => {
    it('fetches version detail from /info with a bearer token', async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchFn = mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ url, init });
        if (url.endsWith('/health')) return new Response(healthBody, { status: 200 });
        return new Response(infoBody('0.5.0', '27.1.1'), { status: 200 });
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => 'jwt-123');

      expect(result.healthy).toBe(true);
      if (result.healthy) {
        expect(result.version).toBe('0.5.0');
        expect(result.dockerVersion).toBe('27.1.1');
      }
      expect(calls[1].url).toBe('http://agent:9090/info');
      const headers = calls[1].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer jwt-123');
    });

    it('stays healthy without version when /info request fails', async () => {
      const fetchFn = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/health')) return new Response(healthBody, { status: 200 });
        return new Response('Unauthorized', { status: 401 });
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => 'jwt-123');

      expect(result.healthy).toBe(true);
      if (result.healthy) expect(result.version).toBeUndefined();
    });

    it('stays healthy without version when getToken throws (no keypair enrolled)', async () => {
      const fetchFn = mock(async () =>
        new Response(healthBody, { status: 200 })
      ) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => {
        throw new Error('No agent keypair found for host x');
      });

      expect(result.healthy).toBe(true);
      if (result.healthy) expect(result.version).toBeUndefined();
    });

    it('stays healthy without version when /info returns non-JSON', async () => {
      const fetchFn = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/health')) return new Response(healthBody, { status: 200 });
        return new Response('not json', { status: 200 });
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => 'jwt-123');

      expect(result.healthy).toBe(true);
      if (result.healthy) expect(result.version).toBeUndefined();
    });

    it('does not call /info when /health already failed', async () => {
      const calls: string[] = [];
      const fetchFn = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push(url);
        return new Response('down', { status: 503 });
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => 'jwt-123');

      expect(result.healthy).toBe(false);
      expect(calls).toEqual(['http://agent:9090/health']);
    });
  });
});

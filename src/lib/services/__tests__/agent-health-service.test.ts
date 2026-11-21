import { describe, it, expect, mock, spyOn } from 'bun:test';
import { checkAgentHealth } from '../agent-health-service';

// Use dependency injection (fetchFn parameter) instead of global fetch mock
// per AGENTS.md rule 7: avoid globalThis mocks, use narrow-scope DI instead.

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
    it('reports awaiting-enrollment when the agent answers on plain HTTP but no pin matches the https URL', async () => {
      const calls: string[] = [];
      const fetchFn = mock(async (url: string) => {
        calls.push(url);
        return new Response(healthBody, { status: 200 });
      }) as unknown as typeof fetch;

      // agentFetch refuses an https URL with no pin before touching fetchFn, so the
      // only call the probe makes is the plain-HTTP sibling.
      const result = await checkAgentHealth('https://agent:9090', undefined, fetchFn, undefined, null);

      expect(calls).toEqual(['http://agent:9090/health']);
      expect(result.healthy).toBe(false);
      if (!result.healthy) {
        expect(result.reason).toBe('awaiting-enrollment');
        expect(result.error).toBe(
          'The agent is serving plain HTTP awaiting TLS enrollment, so the manager cannot verify it over https. Open the Managed Hosts card and run Rotate TLS to enroll a replacement certificate.',
        );
      }
    });

    it('stays offline when no pin matches and nothing answers on plain HTTP', async () => {
      const fetchFn = mock(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('https://agent:9090', undefined, fetchFn, undefined, null);

      expect(result.healthy).toBe(false);
      if (!result.healthy) {
        expect(result.reason).toBe('offline');
        expect(result.error).toContain('No pinned TLS certificate');
      }
    });

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
      if (!result.healthy) {
        expect(result.error).toContain('500');
        expect(result.reason).toBe('unreachable');
      }
    });

    it('reports an agent that answers 503 unhealthy as agent-unhealthy, not as a wrong URL', async () => {
      const fetchFn = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ status: 'unhealthy' }), { status: 503 }))
      ) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result).toEqual({ healthy: false, reason: 'agent-unhealthy', error: 'Agent reported itself unhealthy' });
    });

    it('keeps a 503 without the agent body, and a non-503 error with it, as unreachable', async () => {
      const proxy503 = mock(() => Promise.resolve(new Response('Service Unavailable', { status: 503 }))) as unknown as typeof fetch;
      const unhealthy500 = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ status: 'unhealthy' }), { status: 500 }))
      ) as unknown as typeof fetch;

      const first = await checkAgentHealth('http://agent:9090', undefined, proxy503);
      const second = await checkAgentHealth('http://agent:9090', undefined, unhealthy500);

      expect(first).toMatchObject({ healthy: false, reason: 'unreachable' });
      expect(second).toMatchObject({ healthy: false, reason: 'unreachable' });
    });

    it('treats a 503 body far larger than the agent sends as unreachable without reading it all', async () => {
      const big = JSON.stringify({ status: 'unhealthy', pad: 'x'.repeat(64 * 1024) });
      const fetchFn = mock(() => Promise.resolve(new Response(big, { status: 503 }))) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result).toMatchObject({ healthy: false, reason: 'unreachable' });
    });

    it('reports a pinned certificate that fails verification as certificate-rejected', async () => {
      const fetchFn = mock(() =>
        Promise.reject(Object.assign(new TypeError('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }))
      ) as unknown as typeof fetch;

      const result = await checkAgentHealth('https://agent:9090', undefined, fetchFn, undefined, 'PINNED-PEM');

      expect(result).toEqual({ healthy: false, reason: 'certificate-rejected', error: 'self signed certificate' });
    });

    it('returns unhealthy result when fetch throws (network error)', async () => {
      const fetchFn = mock(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result.healthy).toBe(false);
      if (!result.healthy) {
        expect(result.error).toContain('ECONNREFUSED');
        expect(result.reason).toBe('offline');
      }
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

    it('returns unhealthy when /health body is JSON but missing status field', async () => {
      const fetchFn = mock(async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      ) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toContain('status');
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

    it('stays healthy without version when /info request fails, and logs the error', async () => {
      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
      const fetchFn = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/health')) return new Response(healthBody, { status: 200 });
        return new Response('Unauthorized', { status: 401 });
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => 'jwt-123');

      expect(result.healthy).toBe(true);
      if (result.healthy) expect(result.version).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('401'));
      consoleSpy.mockRestore();
    });

    it('stays healthy without version when getToken throws, and does not log', async () => {
      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
      const fetchFn = mock(async () =>
        new Response(healthBody, { status: 200 })
      ) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => {
        throw new Error('No agent keypair found for host x');
      });

      expect(result.healthy).toBe(true);
      if (result.healthy) expect(result.version).toBeUndefined();
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('stays healthy without version when /info returns non-JSON, and logs the error', async () => {
      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
      const fetchFn = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/health')) return new Response(healthBody, { status: 200 });
        return new Response('not json', { status: 200 });
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => 'jwt-123');

      expect(result.healthy).toBe(true);
      if (result.healthy) expect(result.version).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('reports infoSupported false and logs at info level when /info 404s', async () => {
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const infoSpy = spyOn(console, 'info').mockImplementation(() => {});
      const fetchFn = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/health')) return new Response(healthBody, { status: 200 });
        return new Response('Not Found', { status: 404 });
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => 'jwt-123');

      expect(result.healthy).toBe(true);
      if (result.healthy) {
        expect(result.version).toBeUndefined();
        expect(result.infoSupported).toBe(false);
      }
      expect(errorSpy).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('no /info endpoint'));
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('reports infoSupported true when /info answers', async () => {
      const fetchFn = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/health')) return new Response(healthBody, { status: 200 });
        return new Response(infoBody(), { status: 200 });
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => 'jwt-123');

      expect(result.healthy).toBe(true);
      if (result.healthy) expect(result.infoSupported).toBe(true);
    });

    it('surfaces the agent image reported by /info', async () => {
      const body = JSON.stringify({
        status: 'healthy',
        agentVersion: '0.1.0',
        agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:dev',
        agentImageTag: 'dev',
        capabilities: { docker: { available: true }, zfs: { available: false } },
      });
      const fetchFn = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/health')) return new Response(healthBody, { status: 200 });
        return new Response(body, { status: 200 });
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => 'jwt-123');

      expect(result.healthy).toBe(true);
      if (result.healthy) {
        expect(result.agentImage).toBe('ghcr.io/jaredglaser/homelab-manager-agent:dev');
        expect(result.agentImageTag).toBe('dev');
      }
    });

    it('reports null image fields for an agent that predates image reporting', async () => {
      const fetchFn = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/health')) return new Response(healthBody, { status: 200 });
        return new Response(infoBody(), { status: 200 });
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => 'jwt-123');

      expect(result.healthy).toBe(true);
      if (result.healthy) {
        expect(result.agentImage).toBeNull();
        expect(result.agentImageTag).toBeNull();
        expect(result.infoSupported).toBe(true);
      }
    });

    it.each([
      ['a 300-character image reference', 'x'.repeat(300), null],
      ['an empty string', '', null],
      ['a non-string', 42, null],
      ['a padded reference', '  ghcr.io/x/agent:dev  ', 'ghcr.io/x/agent:dev'],
    ])('bounds %s reported by the agent', async (_label, reported, expected) => {
      const body = JSON.stringify({
        status: 'healthy',
        agentVersion: '0.1.0',
        agentImage: reported,
        agentImageTag: reported,
        capabilities: { docker: { available: true }, zfs: { available: false } },
      });
      const fetchFn = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/health')) return new Response(healthBody, { status: 200 });
        return new Response(body, { status: 200 });
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => 'jwt-123');

      expect(result.healthy).toBe(true);
      if (result.healthy) {
        expect(result.agentImage).toBe(expected);
        expect(result.agentImageTag).toBe(expected);
      }
    });

    it('bounds the version fields the agent reports, not just the image ones', async () => {
      const body = JSON.stringify({
        status: 'healthy',
        agentVersion: 'x'.repeat(300),
        capabilities: { docker: { available: true, version: 'y'.repeat(300) }, zfs: { available: false } },
      });
      const fetchFn = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/health')) return new Response(healthBody, { status: 200 });
        return new Response(body, { status: 200 });
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => 'jwt-123');

      expect(result.healthy).toBe(true);
      if (result.healthy) {
        expect(result.version).toBeUndefined();
        expect(result.dockerVersion).toBeUndefined();
      }
    });

    it('keeps a reference exactly at the 256-character bound', async () => {
      const reference = 'x'.repeat(256);
      const body = JSON.stringify({
        status: 'healthy',
        agentVersion: '0.1.0',
        agentImage: reference,
        agentImageTag: 'dev',
        capabilities: { docker: { available: true }, zfs: { available: false } },
      });
      const fetchFn = mock(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/health')) return new Response(healthBody, { status: 200 });
        return new Response(body, { status: 200 });
      }) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => 'jwt-123');
      if (result.healthy) expect(result.agentImage).toBe(reference);
    });

    it('leaves infoSupported undefined when getToken throws', async () => {
      const fetchFn = mock(async () =>
        new Response(healthBody, { status: 200 })
      ) as unknown as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn, async () => {
        throw new Error('No agent keypair found for host x');
      });

      expect(result.healthy).toBe(true);
      if (result.healthy) expect(result.infoSupported).toBeUndefined();
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

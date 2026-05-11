import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { AgentClient, AgentClientError, type ZfsPool } from '../agent-client';

describe('AgentClient', () => {
  let client: AgentClient;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock();
    client = new AgentClient({
      agentUrl: 'http://agent:9090',
      signer: async () => 'mock-jwt',
      timeoutMs: 5000,
      fetchFn: fetchMock as unknown as typeof fetch,
    });
  });

  describe('deploy', () => {
    it('sends POST to /stacks/deploy with correct headers and body', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success', stdout: 'deployed', stderr: '' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.deploy({
        stack: 'plex',
        composeContent: 'version: "3"',
        envContent: 'KEY=val',
        action: 'deploy',
      });

      expect(result.success).toBe(true);
      expect(result.logs).toBe('deployed');

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/stacks/deploy');
      expect(options.method).toBe('POST');
      expect(options.headers['Authorization']).toBe('Bearer mock-jwt');
      expect(options.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body);
      expect(body.stack).toBe('plex');
      expect(body.composeContent).toBe('version: "3"');
    });

    it('throws AgentClientError on non-200 response', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 })
      );

      await expect(client.deploy({
        stack: 'plex',
        composeContent: 'version: "3"',
        envContent: '',
        action: 'deploy',
      })).rejects.toThrow(AgentClientError);
    });

    it('throws AgentClientError on invalid JSON response', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('<html>Bad Gateway</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      await expect(client.deploy({
        stack: 'plex',
        composeContent: 'version: "3"',
        envContent: '',
        action: 'deploy',
      })).rejects.toThrow(/invalid JSON.*\/stacks\/deploy/);
    });

    it('throws AgentClientError on fetch failure (network error)', async () => {
      // Network errors retry up to 3 times: reject all attempts so we see the final error.
      fetchMock.mockRejectedValue(new Error('Connection refused'));

      await expect(client.deploy({
        stack: 'plex',
        composeContent: 'version: "3"',
        envContent: '',
        action: 'deploy',
      })).rejects.toThrow(AgentClientError);
    });

    it('throws AgentClientError when agent URL returns a redirect (3xx)', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { Location: 'http://169.254.169.254/metadata' } })
      );

      await expect(client.deploy({
        stack: 'plex',
        composeContent: 'version: "3"',
        envContent: '',
        action: 'deploy',
      })).rejects.toThrow(/redirect/);
    });

    it('passes redirect: manual to fetch', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success', stdout: 'ok', stderr: '' }), { status: 200 })
      );

      await client.deploy({ stack: 'plex', composeContent: 'version: "3"', envContent: '', action: 'deploy' });

      const [, options] = fetchMock.mock.calls[0];
      expect(options.redirect).toBe('manual');
    });
  });

  describe('teardown', () => {
    it('sends POST to /stacks/teardown', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success', stdout: 'torn down', stderr: '' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.teardown('plex');
      expect(result.success).toBe(true);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/stacks/teardown');
    });
  });

  describe('restart', () => {
    it('sends POST to /stacks/restart with scope:stack body', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success', stdout: 'restarted', stderr: '' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.restart({ stack: 'plex', scope: 'stack' });
      expect(result.success).toBe(true);
      expect(result.logs).toBe('restarted');

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/stacks/restart');
      const body = JSON.parse(options.body);
      expect(body.stack).toBe('plex');
      expect(body.scope).toBe('stack');
    });

    it('sends service name when scope is service', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success', stdout: '', stderr: '' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await client.restart({ stack: 'plex', scope: 'service', service: 'web' });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.scope).toBe('service');
      expect(body.service).toBe('web');
    });
  });

  describe('start', () => {
    it('sends POST to /stacks/start with scope:stack body', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success', stdout: '', stderr: '' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.start({ stack: 'plex', scope: 'stack' });
      expect(result.success).toBe(true);

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/stacks/start');
      expect(options.method).toBe('POST');
      const body = JSON.parse(options.body);
      expect(body.stack).toBe('plex');
      expect(body.scope).toBe('stack');
      expect(body.service).toBeUndefined();
    });

    it('sends service name when scope is service', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success', stdout: '', stderr: '' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await client.start({ stack: 'plex', scope: 'service', service: 'web' });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.scope).toBe('service');
      expect(body.service).toBe('web');
    });
  });

  describe('stop', () => {
    it('sends POST to /stacks/stop with scope:stack body', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success', stdout: '', stderr: '' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.stop({ stack: 'plex', scope: 'stack' });
      expect(result.success).toBe(true);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/stacks/stop');
    });

    it('sends service name when scope is service', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success', stdout: '', stderr: '' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await client.stop({ stack: 'plex', scope: 'service', service: 'db' });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.service).toBe('db');
    });
  });

  describe('health', () => {
    it('returns health info from GET /health', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: 'healthy',
          agentVersion: '0.1.0',
          docker: { version: '24.0.7', apiVersion: '1.43' },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.health();
      expect(result.status).toBe('healthy');
      expect(result.version).toBe('0.1.0');
    });

    it('throws AgentClientError when agent is unreachable', async () => {
      // Network errors retry up to 3 times: reject all attempts.
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(client.health()).rejects.toThrow(AgentClientError);
    });

    it('mints a fresh JWT per request via signer', async () => {
      let counter = 0;
      const signer = async () => `jwt-${++counter}`;
      const fetchFn = mock(async () =>
        new Response(JSON.stringify({ status: 'healthy', version: '1.0.0', docker: { version: '24' } }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };
      const client = new AgentClient({ agentUrl: 'http://x', signer, fetchFn });
      await client.health();
      await client.health();
      const headers0 = fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>;
      const headers1 = fetchFn.mock.calls[1]?.[1]?.headers as Record<string, string>;
      expect(headers0?.Authorization).toBe('Bearer jwt-1');
      expect(headers1?.Authorization).toBe('Bearer jwt-2');
    });
  });

  describe('getZfsPools', () => {
    it('returns parsed pool list from agent', async () => {
      const pools: ZfsPool[] = [
        {
          name: 'tank',
          size: 1000000000,
          allocated: 500000000,
          free: 500000000,
          fragmentation: 5,
          capacity: 50,
          dedup: 1,
          health: 'ONLINE',
        },
      ];

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ pools }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.getZfsPools();
      expect(result).toEqual(pools);

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/zfs/pools');
      expect(options.method).toBe('GET');
      expect(options.headers['Authorization']).toBe('Bearer mock-jwt');
    });

    it('handles null fragmentation', async () => {
      const pools: ZfsPool[] = [
        {
          name: 'data',
          size: 2000000000,
          allocated: 100000000,
          free: 1900000000,
          fragmentation: null,
          capacity: 5,
          dedup: 1,
          health: 'ONLINE',
        },
      ];

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ pools }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.getZfsPools();
      expect(result[0].fragmentation).toBeNull();
    });

    it('throws AgentClientError on non-200 response', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('Forbidden', { status: 403 })
      );

      await expect(client.getZfsPools()).rejects.toThrow(AgentClientError);
    });
  });

  describe('streamZfsStats', () => {
    it('yields parsed SSE events from stream', async () => {
      const events = [
        { line: 'tank  1.00G  512M  512M  -  -  5%  51%  1.00x  ONLINE  -', timestamp: 1000 },
        { line: 'data  2.00G  100M  1.90G  -  -  0%  5%  1.00x  ONLINE  -', timestamp: 2000 },
      ];

      const sseBody = events.map(e => `data: ${JSON.stringify(e)}\n`).join('\n') + '\n';
      const encoder = new TextEncoder();
      const encoded = encoder.encode(sseBody);

      let offset = 0;
      const readable = new ReadableStream({
        pull(controller) {
          if (offset < encoded.length) {
            controller.enqueue(encoded.slice(offset));
            offset = encoded.length;
          } else {
            controller.close();
          }
        },
      });

      fetchMock.mockResolvedValueOnce(
        new Response(readable, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const controller = new AbortController();
      const results: typeof events = [];
      for await (const event of client.streamZfsStats(controller.signal)) {
        results.push(event);
      }

      expect(results).toEqual(events);
    });

    it('throws AgentClientError on non-200 response', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401 })
      );

      const controller = new AbortController();
      const gen = client.streamZfsStats(controller.signal);
      await expect(gen.next()).rejects.toThrow(AgentClientError);
    });

    it('throws AgentClientError when agent URL returns a redirect (3xx)', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/metadata' } })
      );

      const controller = new AbortController();
      const gen = client.streamZfsStats(controller.signal);
      await expect(gen.next()).rejects.toThrow(/redirect/);
      const [, options] = fetchMock.mock.calls[0];
      expect(options.redirect).toBe('manual');
    });

    it('throws AgentClientError when response has no body', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 200 })
      );

      const controller = new AbortController();
      const gen = client.streamZfsStats(controller.signal);
      await expect(gen.next()).rejects.toThrow(AgentClientError);
    });

    it('handles stream end gracefully with no events', async () => {
      const readable = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      fetchMock.mockResolvedValueOnce(
        new Response(readable, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const controller = new AbortController();
      const results = [];
      for await (const event of client.streamZfsStats(controller.signal)) {
        results.push(event);
      }

      expect(results).toHaveLength(0);
    });

    it('skips malformed SSE events', async () => {
      const sseBody = 'data: {valid: json}\ndata: {"line":"ok","timestamp":999}\n\n';
      const encoder = new TextEncoder();
      const encoded = encoder.encode(sseBody);

      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      });

      fetchMock.mockResolvedValueOnce(
        new Response(readable, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const controller = new AbortController();
      const results = [];
      for await (const event of client.streamZfsStats(controller.signal)) {
        results.push(event);
      }

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ line: 'ok', timestamp: 999 });
    });
  });

  describe('retry behaviour', () => {
    // Collapse retry backoff sleeps so we don't wait real 1s/2s intervals.
    // Scoped to this block so stream tests above keep real setTimeout.
    let setTimeoutSpy: ReturnType<typeof spyOn>;
    let capturedDelays: number[];

    beforeEach(() => {
      capturedDelays = [];
      setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
        ((fn: TimerHandler, delay?: number) => {
          capturedDelays.push(delay ?? 0);
          if (typeof fn === 'function') fn();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof setTimeout,
      );
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
    });

    const successResponse = () =>
      new Response(JSON.stringify({ status: 'success', stdout: 'ok', stderr: '' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const deployPayload = {
      stack: 'plex',
      composeContent: 'version: "3"',
      envContent: '',
      action: 'deploy' as const,
    };

    it('success on first attempt → fetch called once, no retry', async () => {
      fetchMock.mockResolvedValueOnce(successResponse());

      const result = await client.deploy(deployPayload);

      expect(result.success).toBe(true);
      expect(fetchMock.mock.calls).toHaveLength(1);
      expect(capturedDelays).toEqual([]);
    });

    it('network error on attempts 1 & 2, success on 3 → fetch called 3 times', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
      fetchMock.mockResolvedValueOnce(successResponse());

      const result = await client.deploy(deployPayload);

      expect(result.success).toBe(true);
      expect(fetchMock.mock.calls).toHaveLength(3);
      // 1s then 2s (baseMs 1000, maxExponent 2 → 2^0=1, 2^1=2).
      expect(capturedDelays).toEqual([1000, 2000]);
    });

    it('503 on attempt 1, 200 on attempt 2 → fetch called 2 times', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }));
      fetchMock.mockResolvedValueOnce(successResponse());

      const result = await client.deploy(deployPayload);

      expect(result.success).toBe(true);
      expect(fetchMock.mock.calls).toHaveLength(2);
      expect(capturedDelays).toEqual([1000]);
    });

    it('400 on attempt 1 → throws immediately, fetch called once', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

      let thrown: unknown;
      try {
        await client.deploy(deployPayload);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AgentClientError);
      expect((thrown as AgentClientError).statusCode).toBe(400);
      expect(fetchMock.mock.calls).toHaveLength(1);
      expect(capturedDelays).toEqual([]);
    });

    it('500 (non-retryable 5xx) → throws immediately, fetch called once', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

      let thrown: unknown;
      try {
        await client.deploy(deployPayload);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AgentClientError);
      expect((thrown as AgentClientError).statusCode).toBe(500);
      expect(fetchMock.mock.calls).toHaveLength(1);
      expect(capturedDelays).toEqual([]);
    });

    it('504 all 3 attempts → throws AgentClientError with statusCode 504 after 3 fetches', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Gateway Timeout', { status: 504 }));
      fetchMock.mockResolvedValueOnce(new Response('Gateway Timeout', { status: 504 }));
      fetchMock.mockResolvedValueOnce(new Response('Gateway Timeout', { status: 504 }));

      let thrown: unknown;
      try {
        await client.deploy(deployPayload);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AgentClientError);
      expect((thrown as AgentClientError).statusCode).toBe(504);
      expect(fetchMock.mock.calls).toHaveLength(3);
      expect(capturedDelays).toEqual([1000, 2000]);
    });

    it('network error all 3 attempts → throws with statusCode undefined after 3 fetches', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      let thrown: unknown;
      try {
        await client.deploy(deployPayload);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AgentClientError);
      expect((thrown as AgentClientError).statusCode).toBeUndefined();
      expect((thrown as AgentClientError).wasTimeout).toBe(false);
      expect(fetchMock.mock.calls).toHaveLength(3);
      expect(capturedDelays).toEqual([1000, 2000]);
    });

    it('per-attempt timeout → throws with wasTimeout true, fetch called exactly once', async () => {
      // Simulate AbortSignal.timeout() rejection with a TimeoutError.
      const timeoutErr = new Error('The operation timed out.');
      timeoutErr.name = 'TimeoutError';
      fetchMock.mockRejectedValueOnce(timeoutErr);

      let thrown: unknown;
      try {
        await client.deploy(deployPayload);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AgentClientError);
      expect((thrown as AgentClientError).wasTimeout).toBe(true);
      expect((thrown as AgentClientError).statusCode).toBeUndefined();
      expect(fetchMock.mock.calls).toHaveLength(1);
      expect(capturedDelays).toEqual([]);
    });

    it('AbortError (runtime variant of timeout) → wasTimeout true, no retry', async () => {
      const abortErr = new Error('The operation was aborted.');
      abortErr.name = 'AbortError';
      fetchMock.mockRejectedValueOnce(abortErr);

      let thrown: unknown;
      try {
        await client.deploy(deployPayload);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AgentClientError);
      expect((thrown as AgentClientError).wasTimeout).toBe(true);
      expect(fetchMock.mock.calls).toHaveLength(1);
      expect(capturedDelays).toEqual([]);
    });

    it('invalid JSON response → throws immediately (non-retryable), fetch called once', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('<html>Not JSON</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );

      let thrown: unknown;
      try {
        await client.deploy(deployPayload);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AgentClientError);
      expect((thrown as AgentClientError).message).toMatch(/invalid JSON/);
      expect(fetchMock.mock.calls).toHaveLength(1);
      expect(capturedDelays).toEqual([]);
    });
  });
});

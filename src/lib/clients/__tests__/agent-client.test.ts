import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { AgentClient, AgentClientError, type ZfsPool } from '../agent-client';
import { mockSetTimeout, type TimerMock } from '@/lib/test/mock-timers';
import type { AgentDeployResponse } from '@/lib/deploy/types';

function chunkedBody(chunks: Array<Uint8Array | Error>): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let index = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const next = chunks[index++];
      if (next instanceof Error) controller.error(next);
      else controller.enqueue(next);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

function smallChunks(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  const pieces: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += size) pieces.push(bytes.slice(at, at + size));
  return chunkedBody(pieces).body;
}

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
      caCertPem: null,
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

    it('reads the failure code out of a coded error body, and keeps its JSON out of the message', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Stack 'plex' not found", code: 'stack_not_found' }), { status: 404 })
      );

      let thrown: unknown;
      try {
        await client.deploy({
          stack: 'plex',
          composeContent: 'version: "3"',
          envContent: '',
          action: 'deploy',
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(AgentClientError);
      expect((thrown as AgentClientError).code).toBe('stack_not_found');
      expect((thrown as AgentClientError).message).toBe("Agent returned 404: Stack 'plex' not found");
    });

    it('appends the body detail to the message', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'Failed to list ZFS pools', code: 'zfs_pool_list_failed', detail: 'no such command' }),
          { status: 500 }
        )
      );

      let thrown: unknown;
      try {
        await client.deploy({
          stack: 'plex',
          composeContent: 'version: "3"',
          envContent: '',
          action: 'deploy',
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(AgentClientError);
      expect((thrown as AgentClientError).message).toBe('Agent returned 500: Failed to list ZFS pools: no such command');
      expect((thrown as AgentClientError).code).toBe('zfs_pool_list_failed');
    });

    it('keeps a code this manager does not know off the error, and the body text on it', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Something new went wrong', code: 'invented_later' }), { status: 400 })
      );

      let thrown: unknown;
      try {
        await client.deploy({
          stack: 'plex',
          composeContent: 'version: "3"',
          envContent: '',
          action: 'deploy',
        });
      } catch (err) {
        thrown = err;
      }

      expect((thrown as AgentClientError).code).toBeUndefined();
      expect((thrown as AgentClientError).message).toBe('Agent returned 400: Something new went wrong');
    });

    describe('failure body', () => {
      const deployPayload = { stack: 'plex', composeContent: 'version: "3"', envContent: '', action: 'deploy' as const };

      async function failureOf(response: Response, call: () => Promise<unknown> = () => client.restartContainer('abc123')): Promise<AgentClientError> {
        fetchMock.mockResolvedValueOnce(response);
        try {
          await call();
        } catch (err) {
          expect(err).toBeInstanceOf(AgentClientError);
          return err as AgentClientError;
        }
        throw new Error('expected the call to fail');
      }

      it('keeps a short non-JSON error body as the message', async () => {
        const thrown = await failureOf(new Response('<html>Bad Gateway</html>', { status: 500 }));

        expect(thrown.message).toBe('Agent returned 500: <html>Bad Gateway</html>');
        expect(thrown.code).toBeUndefined();
      });

      it('flattens a multi-line HTML proxy page to one line and still retries a 502', async () => {
        const timers = mockSetTimeout({ fireImmediately: true });
        try {
          fetchMock.mockImplementation(() =>
            Promise.resolve(new Response('<html>\n<head><title>502 Bad Gateway</title></head>\r\n<body>nginx</body>\n</html>\n', { status: 502 })),
          );

          let thrown: unknown;
          try {
            await client.deploy(deployPayload);
          } catch (err) {
            thrown = err;
          }

          expect((thrown as AgentClientError).message).toBe(
            'Agent returned 502: <html> <head><title>502 Bad Gateway</title></head> <body>nginx</body> </html>',
          );
          expect((thrown as AgentClientError).statusCode).toBe(502);
          expect((thrown as AgentClientError).code).toBeUndefined();
          expect(fetchMock.mock.calls).toHaveLength(3);
          expect(timers.delays).toEqual([1000, 2000]);
        } finally {
          timers.restore();
        }
      });

      it('replaces newlines and control characters in a plain-text body so it cannot forge a log line', async () => {
        const thrown = await failureOf(new Response('first\nsecond\r\n\u0000\u001b[31mred\u007f', { status: 500 }));

        expect(thrown.message).toBe('Agent returned 500: first second [31mred');
      });

      it('cuts a long non-JSON body to 300 characters and cancels the stream', async () => {
        const chunk = new TextEncoder().encode('x'.repeat(4096));
        const { body, cancelled } = chunkedBody(Array.from({ length: 64 }, () => chunk));
        const thrown = await failureOf(new Response(body, { status: 500 }));

        expect(thrown.message).toBe(`Agent returned 500: ${'x'.repeat(300)}...`);
        expect(cancelled()).toBe(true);
      });

      it('stops reading a body that never ends once the cap is passed', async () => {
        const chunk = new TextEncoder().encode('y'.repeat(4096));
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(chunk);
          },
        });

        const thrown = await failureOf(new Response(body, { status: 500 }));

        expect(thrown.message).toBe(`Agent returned 500: ${'y'.repeat(300)}...`);
        expect(pulls).toBe(8192 / 4096 + 1);
      });

      it.each([['a number', 42], ['null', null]])('gives just the error when the detail is %s', async (_name, detail) => {
        const thrown = await failureOf(
          new Response(JSON.stringify({ error: 'Failed to run compose', code: 'compose_spawn_failed', detail }), { status: 500 }),
        );

        expect(thrown.message).toBe('Agent returned 500: Failed to run compose');
        expect(thrown.code).toBe('compose_spawn_failed');
      });

      it('keeps the code of a coded body just under the read cap, delivered in small chunks', async () => {
        const encoded = new TextEncoder().encode(JSON.stringify({ error: 'e'.repeat(7500), code: 'stack_not_found' }));
        const thrown = await failureOf(new Response(smallChunks(encoded, 1024), { status: 404 }));

        expect(thrown.code).toBe('stack_not_found');
        expect(thrown.message).toBe(`Agent returned 404: ${'e'.repeat(300)}...`);
      });

      it('loses the code of a coded body of 8200 bytes delivered as 8192 and 8', async () => {
        const prefix = '{"error":"';
        const suffix = '","code":"stack_not_found"}';
        const encoded = new TextEncoder().encode(`${prefix}${'e'.repeat(8200 - prefix.length - suffix.length)}${suffix}`);
        expect(encoded.byteLength).toBe(8200);
        const { body, cancelled } = chunkedBody([encoded.slice(0, 8192), encoded.slice(8192)]);

        const thrown = await failureOf(new Response(body, { status: 404 }));

        expect(thrown.code).toBeUndefined();
        expect(thrown.message).toBe(`Agent returned 404: ${prefix}${'e'.repeat(300 - prefix.length)}...`);
        expect(cancelled()).toBe(true);
      });

      it('reads exactly the chunks up to the cap and no further', async () => {
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(new TextEncoder().encode('z'.repeat(1024)));
          },
        });

        await failureOf(new Response(body, { status: 500 }));

        expect(pulls).toBe(8192 / 1024 + 1);
      });

      it('keeps a multi-byte character that is split across two chunks', async () => {
        const encoded = new TextEncoder().encode('caf\u00e9 is down');
        const { body } = chunkedBody([encoded.slice(0, 4), encoded.slice(4)]);

        const thrown = await failureOf(new Response(body, { status: 500 }));

        expect(thrown.message).toBe('Agent returned 500: caf\u00e9 is down');
      });

      it('flattens and cuts the error and detail of a coded body separately and keeps its code', async () => {
        const thrown = await failureOf(
          new Response(
            JSON.stringify({ error: 'Failed to\nrun compose', code: 'compose_spawn_failed', detail: `line one\nline two ${'d'.repeat(400)}` }),
            { status: 500 },
          ),
        );

        expect(thrown.message).toBe(`Agent returned 500: Failed to run compose: line one line two ${'d'.repeat(282)}...`);
        expect(thrown.code).toBe('compose_spawn_failed');
      });

      it('drops a detail that is empty once its control characters are removed', async () => {
        const thrown = await failureOf(
          new Response(JSON.stringify({ error: 'Failed to run compose', code: 'compose_spawn_failed', detail: '\n\t ' }), { status: 500 }),
        );

        expect(thrown.message).toBe('Agent returned 500: Failed to run compose');
      });

      it('cuts the error text of a coded body that is a single very long line', async () => {
        const thrown = await failureOf(
          new Response(JSON.stringify({ error: 'e'.repeat(1000), code: 'stack_not_found' }), { status: 404 }),
        );

        expect(thrown.message).toBe(`Agent returned 404: ${'e'.repeat(300)}...`);
        expect(thrown.code).toBe('stack_not_found');
      });

      it.each([['a JSON string', '"oops"'], ['an array', '[]'], ['null', 'null'], ['a number', '42'], ['an object with no error text', '{"error":7}']])(
        'keeps %s body as plain text with no code',
        async (_name, text) => {
          const thrown = await failureOf(new Response(text, { status: 500 }));

          expect(thrown.message).toBe(`Agent returned 500: ${text}`);
          expect(thrown.code).toBeUndefined();
        },
      );

      it('reports an empty body with the status alone', async () => {
        const thrown = await failureOf(new Response('', { status: 500 }));

        expect(thrown.message).toBe('Agent returned 500: ');
        expect(thrown.statusCode).toBe(500);
        expect(thrown.code).toBeUndefined();
      });

      it('reads a coded body that is cut off by the read cap as an unreadable body with no code', async () => {
        const encoded = new TextEncoder().encode(JSON.stringify({ error: 'e'.repeat(20_000), code: 'stack_not_found' }));
        const { body } = chunkedBody(Array.from({ length: 5 }, (_, i) => encoded.slice(i * 4096, (i + 1) * 4096)));

        const thrown = await failureOf(new Response(body, { status: 404 }));

        expect(thrown.message).toBe(`Agent returned 404: {"error":"${'e'.repeat(300 - '{"error":"'.length)}...`);
        expect(thrown.code).toBeUndefined();
      });

      it('keeps what arrived when the body stream errors mid-read', async () => {
        const { body } = chunkedBody([new TextEncoder().encode('upstream said: conn'), new Error('connection reset')]);

        const thrown = await failureOf(new Response(body, { status: 500 }));

        expect(thrown).toBeInstanceOf(AgentClientError);
        expect(thrown.message).toBe('Agent returned 500: upstream said: conn');
        expect(thrown.statusCode).toBe(500);
      });

      it('flattens and cuts a 200 HTML proxy page in the invalid JSON message', async () => {
        const thrown = await failureOf(
          new Response(`<html>\n<body>${'p'.repeat(500)}</body>\n</html>`, { status: 200, headers: { 'Content-Type': 'text/html' } }),
          () => client.deploy(deployPayload),
        );

        expect(thrown.message).toBe(`Agent returned invalid JSON from http://agent:9090/stacks/deploy: <html> <body>${'p'.repeat(300 - '<html> <body>'.length)}...`);
        expect(thrown.statusCode).toBe(200);
        expect(thrown.code).toBeUndefined();
      });
    });

    describe('compose failure result', () => {
      const deployPayload = { stack: 'plex', composeContent: 'version: "3"', envContent: '', action: 'deploy' as const };
      const finalLine = 'Error response from daemon: pull access denied for foo/bar, repository does not exist or may require authorization';
      const pullLog = [...Array.from({ length: 400 }, (_, i) => ` Container app-${String(i).padStart(3, '0')}  Pulling fs layer sha256:${'a'.repeat(24)}`), finalLine].join('\n');
      const calls: Array<[string, () => Promise<AgentDeployResponse>, string]> = [
        ['deploy', () => client.deploy(deployPayload), '/stacks/deploy'],
        ['update', () => client.update({ stack: 'plex', composeContent: 'version: "3"', envContent: '' }), '/stacks/update'],
        ['teardown', () => client.teardown('plex'), '/stacks/teardown'],
        ['restart', () => client.restart({ stack: 'plex', scope: 'stack' }), '/stacks/restart'],
        ['start', () => client.start({ stack: 'plex', scope: 'stack' }), '/stacks/start'],
        ['stop', () => client.stop({ stack: 'plex', scope: 'stack' }), '/stacks/stop'],
      ];

      async function failureOf(response: Response): Promise<AgentClientError> {
        fetchMock.mockResolvedValueOnce(response);
        try {
          await client.deploy(deployPayload);
        } catch (err) {
          expect(err).toBeInstanceOf(AgentClientError);
          return err as AgentClientError;
        }
        throw new Error('expected the deploy to fail');
      }

      it.each(calls)('%s returns a failed result with the whole stdout and stderr from an HTTP 500', async (_name, call, path) => {
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'failed', exitCode: 1, stdout: 'created network', stderr: pullLog }), { status: 500 }),
        );

        const result = await call();

        expect(pullLog.length).toBeGreaterThan(20_000);
        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(1);
        expect(result.logs).toBe(`created network\n${pullLog}`);
        expect(fetchMock.mock.calls).toHaveLength(1);
        expect(fetchMock.mock.calls[0][0]).toBe(`http://agent:9090${path}`);
      });

      it('keeps the timed out text in front of the stderr', async () => {
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'failed', exitCode: 143, stdout: '', stderr: 'Process timed out after 300s. pulling layer 3/9' }), { status: 500 }),
        );

        const result = await client.deploy(deployPayload);

        expect(result).toEqual({ success: false, logs: 'Process timed out after 300s. pulling layer 3/9', exitCode: 143 });
      });

      it('accepts a failed result with no exit code', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'failed', stdout: '', stderr: 'boom' }), { status: 500 }));

        expect(await client.deploy(deployPayload)).toEqual({ success: false, logs: 'boom' });
      });

      it('does not retry a failed result, because that would run compose again', async () => {
        const timers = mockSetTimeout({ fireImmediately: true });
        try {
          fetchMock.mockImplementation(() =>
            Promise.resolve(new Response(JSON.stringify({ status: 'failed', exitCode: 1, stdout: '', stderr: 'boom' }), { status: 503 })),
          );

          const result = await client.deploy(deployPayload);

          expect(result.success).toBe(false);
          expect(fetchMock.mock.calls).toHaveLength(1);
          expect(timers.delays).toEqual([]);
        } finally {
          timers.restore();
        }
      });

      it('still throws the bounded message and the code for a coded error body', async () => {
        const thrown = await failureOf(
          new Response(JSON.stringify({ error: "Stack 'plex' not found", code: 'stack_not_found' }), { status: 404 }),
        );

        expect(thrown).toBeInstanceOf(AgentClientError);
        expect(thrown.message).toBe("Agent returned 404: Stack 'plex' not found");
        expect(thrown.code).toBe('stack_not_found');
      });

      it('still throws a flattened and cut message for an HTML 500 page', async () => {
        const thrown = await failureOf(new Response(`<html>\n<body>${'p'.repeat(500)}</body>\n</html>`, { status: 500 }));

        expect(thrown.message).toBe(`Agent returned 500: <html> <body>${'p'.repeat(300 - '<html> <body>'.length)}...`);
        expect(thrown.code).toBeUndefined();
      });

      it.each([
        ['a numeric stderr and no stdout', { status: 'failed', exitCode: 1, stderr: 5 }],
        ['no output fields', { status: 'failed', exitCode: 1 }],
        ['a success status', { status: 'success', stdout: '', stderr: '' }],
        ['an error message beside the output', { status: 'failed', error: 'Stack is busy', code: 'stack_not_found', stdout: '', stderr: 'boom' }],
      ])('throws through the error path for a body with %s', async (_name, body) => {
        const thrown = await failureOf(new Response(JSON.stringify(body), { status: 500 }));

        expect(thrown.statusCode).toBe(500);
        expect(thrown.message).toStartWith('Agent returned 500: ');
      });

      it('lets the error envelope win over a failed result that carries the same fields', async () => {
        const thrown = await failureOf(
          new Response(JSON.stringify({ status: 'failed', error: 'Stack is busy', code: 'stack_not_found', stdout: '', stderr: 'boom' }), { status: 500 }),
        );

        expect(thrown.message).toBe('Agent returned 500: Stack is busy');
        expect(thrown.code).toBe('stack_not_found');
      });

      it.each([
        ['a null exit code', { status: 'failed', exitCode: null, stdout: 'out', stderr: 'boom' }, { success: false, logs: 'out\nboom' }],
        ['a string exit code', { status: 'failed', exitCode: '1', stdout: 'out', stderr: 'boom' }, { success: false, logs: 'out\nboom' }],
        ['a missing stdout', { status: 'failed', exitCode: 2, stderr: 'boom' }, { success: false, logs: 'boom', exitCode: 2 }],
        ['a missing stderr', { status: 'failed', exitCode: 2, stdout: 'out' }, { success: false, logs: 'out', exitCode: 2 }],
        ['a numeric stdout beside a string stderr', { status: 'failed', exitCode: 2, stdout: 9, stderr: 'boom' }, { success: false, logs: 'boom', exitCode: 2 }],
      ])('still returns the output for a failed body with %s', async (_name, body, expected) => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 500 }));

        expect(await client.deploy(deployPayload)).toEqual(expected);
      });

      it('names the exit code when a failed run printed nothing', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'failed', exitCode: 137, stdout: '', stderr: '' }), { status: 500 }));

        expect(await client.deploy(deployPayload)).toEqual({ success: false, logs: 'docker compose exited with code 137', exitCode: 137 });
      });

      it('says so when a failed run printed nothing and sent no exit code', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'failed', stdout: '\n', stderr: ' ' }), { status: 500 }));

        expect(await client.restart({ stack: 'plex', scope: 'stack' })).toEqual({ success: false, logs: 'docker compose failed with no output' });
      });

      it('throws for a failed result on a 4xx status', async () => {
        const thrown = await failureOf(new Response(JSON.stringify({ status: 'failed', exitCode: 1, stdout: '', stderr: 'boom' }), { status: 400 }));

        expect(thrown.statusCode).toBe(400);
        expect(thrown.message).toBe('Agent returned 400: {"status":"failed","exitCode":1,"stdout":"","stderr":"boom"}');
      });

      it('reads only the bounded 8KB of a 4xx body on a compose route', async () => {
        const encoded = new TextEncoder().encode(JSON.stringify({ error: 'e'.repeat(20_000), code: 'stack_not_found' }));
        const { body, cancelled } = chunkedBody(Array.from({ length: 5 }, (_, i) => encoded.slice(i * 4096, (i + 1) * 4096)));

        const thrown = await failureOf(new Response(body, { status: 404 }));

        expect(thrown.code).toBeUndefined();
        expect(cancelled()).toBe(true);
      });

      it('throws an AgentClientError with the text that arrived and the status when the body stream errors', async () => {
        const { body } = chunkedBody([new TextEncoder().encode('{"status":"failed","stderr":"pull'), new Error('connection reset')]);

        const thrown = await failureOf(new Response(body, { status: 500 }));

        expect(thrown.statusCode).toBe(500);
        expect(thrown.message).toBe('Agent returned 500: {"status":"failed","stderr":"pull');
      });

      it('throws an AgentClientError when the body stream errors before any text', async () => {
        const { body } = chunkedBody([new Error('connection reset')]);

        const thrown = await failureOf(new Response(body, { status: 500 }));

        expect(thrown.statusCode).toBe(500);
        expect(thrown.message).toBe('Agent returned 500: ');
      });
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
      const timers = mockSetTimeout({ fireImmediately: true });
      try {
        fetchMock.mockRejectedValue(new Error('Connection refused'));

        await expect(client.deploy({
          stack: 'plex',
          composeContent: 'version: "3"',
          envContent: '',
          action: 'deploy',
        })).rejects.toThrow(AgentClientError);
        expect(timers.delays).toEqual([1000, 2000]);
      } finally {
        timers.restore();
      }
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

  describe('update', () => {
    it('sends POST to /stacks/update with stack, composeContent, envContent (no forceRecreate)', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success', stdout: 'pulled + up', stderr: '' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.update({
        stack: 'plex',
        composeContent: 'version: "3"',
        envContent: 'KEY=val',
      });

      expect(result.success).toBe(true);
      expect(result.logs).toBe('pulled + up');

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/stacks/update');
      expect(options.method).toBe('POST');
      const body = JSON.parse(options.body);
      expect(body).toEqual({ stack: 'plex', composeContent: 'version: "3"', envContent: 'KEY=val' });
      expect(body.forceRecreate).toBeUndefined();
    });

    it('maps a 404 to a friendly "agent does not support image updates" message', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

      let thrown: unknown;
      try {
        await client.update({ stack: 'plex', composeContent: 'x', envContent: '' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AgentClientError);
      expect((thrown as AgentClientError).message).toBe(
        'Agent on agent:9090 does not support image updates. Update the agent container and retry.',
      );
      expect((thrown as AgentClientError).statusCode).toBe(404);
    });

    it('keeps a coded 404 as it is instead of calling the agent old', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Stack 'plex' not found", code: 'stack_not_found' }), { status: 404 }),
      );

      let thrown: unknown;
      try {
        await client.update({ stack: 'plex', composeContent: 'x', envContent: '' });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as AgentClientError).message).toBe("Agent returned 404: Stack 'plex' not found");
      expect((thrown as AgentClientError).code).toBe('stack_not_found');
    });

    it('passes through non-404 errors unchanged', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

      let thrown: unknown;
      try {
        await client.update({ stack: 'plex', composeContent: 'x', envContent: '' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AgentClientError);
      expect((thrown as AgentClientError).statusCode).toBe(500);
      expect((thrown as AgentClientError).message).not.toContain('does not support image updates');
    });

    it('uses the 960_000ms (16 min) per-attempt timeout', async () => {
      const abortSpy = spyOn(AbortSignal, 'timeout');
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success', stdout: 'ok', stderr: '' }), { status: 200 })
      );

      await client.update({ stack: 'plex', composeContent: 'x', envContent: '' });

      expect(abortSpy).toHaveBeenCalledWith(960_000);
      abortSpy.mockRestore();
    });
  });

  describe('getStackInventory', () => {
    it('returns parsed stack inventory from the agent', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({
          stacks: [
            { name: 'grafana', hasComposeFile: true, composeHash: 'hash-1' },
            { name: 'plex', hasComposeFile: true, composeHash: 'hash-2' },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.getStackInventory();

      expect(result).toEqual({
        stacks: [
          { name: 'grafana', hasComposeFile: true, composeHash: 'hash-1' },
          { name: 'plex', hasComposeFile: true, composeHash: 'hash-2' },
        ],
        errors: [],
      });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/stacks/inventory');
    });

    it('carries per-stack read errors through to the caller', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({
          stacks: [{ name: 'grafana', hasComposeFile: true, composeHash: 'hash-1' }],
          errors: [{ name: 'plex', message: 'EACCES: permission denied' }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.getStackInventory();

      expect(result.stacks).toEqual([{ name: 'grafana', hasComposeFile: true, composeHash: 'hash-1' }]);
      expect(result.errors).toEqual([{ name: 'plex', message: 'EACCES: permission denied' }]);
    });
  });

  describe('getStackCompose', () => {
    it('requests compose content for a specific stack', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({
          stack: 'plex',
          composeContent: 'services: {}',
          composeHash: 'hash-1',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.getStackCompose('plex');

      expect(result).toEqual({
        stack: 'plex',
        composeContent: 'services: {}',
        composeHash: 'hash-1',
      });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/stacks/compose?stack=plex');
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

  describe('startContainer', () => {
    it('sends POST to /containers/:id/start', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success' }), { status: 200 })
      );

      await client.startContainer('abc123');

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/containers/abc123/start');
      expect(options.method).toBe('POST');
      expect(options.headers['Authorization']).toBe('Bearer mock-jwt');
    });

    it('throws AgentClientError on non-200 response', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('Container not found', { status: 404 })
      );
      await expect(client.startContainer('missing')).rejects.toThrow(AgentClientError);
    });
  });

  describe('stopContainer', () => {
    it('sends POST to /containers/:id/stop', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success' }), { status: 200 })
      );

      await client.stopContainer('abc123');

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/containers/abc123/stop');
    });

    it('throws AgentClientError when container is already stopped (409)', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'container already stopped' }), { status: 409 })
      );
      await expect(client.stopContainer('abc123')).rejects.toThrow(AgentClientError);
    });
  });

  describe('restartContainer', () => {
    it('sends POST to /containers/:id/restart', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success' }), { status: 200 })
      );

      await client.restartContainer('abc123');

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/containers/abc123/restart');
    });
  });

  describe('health', () => {
    it('returns agent info from GET /info', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({
          status: 'healthy',
          agentVersion: '0.1.0',
          capabilities: {
            docker: { available: true, version: '24.0.7', apiVersion: '1.43' },
            zfs: { available: false },
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.health();
      expect(result.status).toBe('healthy');
      expect(result.version).toBe('0.1.0');
      expect(fetchMock.mock.calls[0][0]).toBe('http://agent:9090/info');
    });

    it('throws AgentClientError when agent is unreachable', async () => {
      // Network errors retry up to 3 times: reject all attempts.
      const timers = mockSetTimeout({ fireImmediately: true });
      try {
        fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(client.health()).rejects.toThrow(AgentClientError);
        expect(timers.delays).toEqual([1000, 2000]);
      } finally {
        timers.restore();
      }
    });

    it('mints a fresh JWT per request via signer', async () => {
      let counter = 0;
      const signer = async () => `jwt-${++counter}`;
      const fetchFn = mock(async () =>
        new Response(JSON.stringify({ status: 'healthy', version: '1.0.0', docker: { version: '24' } }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };
      const client = new AgentClient({ agentUrl: 'http://x', signer, fetchFn, caCertPem: null });
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

  describe('retry behaviour', () => {
    // Scoped to this block so other describe blocks keep real setTimeout.
    let timers: TimerMock;

    beforeEach(() => {
      timers = mockSetTimeout({ fireImmediately: true });
    });

    afterEach(() => {
      timers.restore();
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
      expect(timers.delays).toEqual([]);
    });

    it('network error on attempts 1 & 2, success on 3 → fetch called 3 times', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
      fetchMock.mockResolvedValueOnce(successResponse());

      const result = await client.deploy(deployPayload);

      expect(result.success).toBe(true);
      expect(fetchMock.mock.calls).toHaveLength(3);
      // 1s then 2s (baseMs 1000, maxExponent 2 → 2^0=1, 2^1=2).
      expect(timers.delays).toEqual([1000, 2000]);
    });

    it('503 on attempt 1, 200 on attempt 2 → fetch called 2 times', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }));
      fetchMock.mockResolvedValueOnce(successResponse());

      const result = await client.deploy(deployPayload);

      expect(result.success).toBe(true);
      expect(fetchMock.mock.calls).toHaveLength(2);
      expect(timers.delays).toEqual([1000]);
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
      expect(timers.delays).toEqual([]);
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
      expect(timers.delays).toEqual([]);
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
      expect(timers.delays).toEqual([1000, 2000]);
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
      expect(timers.delays).toEqual([1000, 2000]);
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
      expect(timers.delays).toEqual([]);
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
      expect(timers.delays).toEqual([]);
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
      expect(timers.delays).toEqual([]);
    });
  });
});

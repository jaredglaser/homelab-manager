import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AgentClient, AgentClientError } from '../agent-client';

describe('AgentClient', () => {
  let client: AgentClient;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock();
    client = new AgentClient({
      agentUrl: 'http://agent:9090',
      agentToken: 'test-token',
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
      expect(options.headers['Authorization']).toBe('Bearer test-token');
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

    it('throws AgentClientError on fetch failure (network error)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(client.deploy({
        stack: 'plex',
        composeContent: 'version: "3"',
        envContent: '',
        action: 'deploy',
      })).rejects.toThrow(AgentClientError);
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
    it('sends POST to /stacks/restart', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'success', stdout: 'restarted', stderr: '' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.restart('plex');
      expect(result.success).toBe(true);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/stacks/restart');
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
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(client.health()).rejects.toThrow(AgentClientError);
    });
  });
});

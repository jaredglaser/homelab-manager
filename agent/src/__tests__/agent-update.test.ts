import { describe, expect, test, mock, beforeAll } from 'bun:test';
import { handleAgentUpdate } from '../routes/agent-update';

beforeAll(() => {
  console.error = mock(() => {});
});

const dockerStub = { ready: true } as never;

describe('handleAgentUpdate', () => {
  test('returns 503 when Docker capability is not enabled', async () => {
    const response = await handleAgentUpdate(null, 'http://hlm-agent-updater:9091/trigger');
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe('Docker capability not enabled');
  });

  test('returns 202 when the updater starts an update', async () => {
    const fetchMock = mock((): Promise<Response> => Promise.resolve(new Response(JSON.stringify({ started: true }), { status: 202 })));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger');
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.started).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://hlm-agent-updater:9091/trigger',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns 200 updateAvailable false when the agent is already current', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({ updateAvailable: false }), { status: 200 })));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.updateAvailable).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns 503 when the updater is unreachable', async () => {
    const fetchMock = mock(() => Promise.reject(new Error('connection refused')));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger');
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toContain('agent-updater');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('relays 409 when an update is already in progress', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({ error: 'An update is already in progress' }), { status: 409 })));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger');
      expect(response.status).toBe(409);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects an unexpected redirect from the updater', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 302 })));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger');
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error).toContain('redirect');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('maps a 200 with an unexpected body to 500', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({ updateAvailable: true, error: 'bad state' }), { status: 200 })));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger');
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('bad state');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('passes through updater errors with their status', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({ error: 'registry unreachable' }), { status: 500 })));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger');
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('registry unreachable');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

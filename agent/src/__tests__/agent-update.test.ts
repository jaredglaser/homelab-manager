import { describe, expect, test, mock, beforeAll } from 'bun:test';
import { handleAgentUpdate } from '../routes/agent-update';

beforeAll(() => {
  console.error = mock(() => {});
});

const dockerStub = { ready: true } as never;

const TRIGGER_TOKEN = 'test-trigger-token';
const TARGET = 'ghcr.io/jaredglaser/homelab-manager-agent@sha256:' + 'a'.repeat(64);
const UPDATER_TARGET = 'ghcr.io/jaredglaser/homelab-manager-agent-updater@sha256:' + 'b'.repeat(64);

function updateRequest(body?: unknown): Request {
  return new Request('http://agent.local/agent/update', {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function withFetch(impl: () => Promise<Response>): { restore: () => void; fetchMock: ReturnType<typeof mock> } {
  const fetchMock = mock(impl);
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, fetchMock };
}

describe('handleAgentUpdate', () => {
  test('returns 503 when Docker capability is not enabled', async () => {
    const response = await handleAgentUpdate(null, 'http://hlm-agent-updater:9091/trigger', TRIGGER_TOKEN, updateRequest({ targetImage: TARGET }));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe('Docker capability not enabled');
  });

  test('returns 503 when the trigger token is not configured', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response('{}', { status: 202 })));
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger', undefined, updateRequest({ targetImage: TARGET }));
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toContain('trigger token');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('returns 202 when the updater starts an update', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ started: true }), { status: 202 })));
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger', TRIGGER_TOKEN, updateRequest({ targetImage: TARGET }));
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.started).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://hlm-agent-updater:9091/trigger',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TRIGGER_TOKEN}` },
          body: JSON.stringify({ targetImage: TARGET }),
        }),
      );
    } finally {
      restore();
    }
  });

  test('forwards both digest-pinned targets to the updater', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ started: true }), { status: 202 })));
    try {
      const response = await handleAgentUpdate(
        dockerStub,
        'http://hlm-agent-updater:9091/trigger',
        TRIGGER_TOKEN,
        updateRequest({ targetImage: TARGET, updaterTargetImage: UPDATER_TARGET }),
      );
      expect(response.status).toBe(202);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://hlm-agent-updater:9091/trigger',
        expect.objectContaining({
          body: JSON.stringify({ targetImage: TARGET, updaterTargetImage: UPDATER_TARGET }),
        }),
      );
    } finally {
      restore();
    }
  });

  test('drops a null updaterTargetImage instead of forwarding it', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ started: true }), { status: 202 })));
    try {
      const response = await handleAgentUpdate(
        dockerStub,
        'http://hlm-agent-updater:9091/trigger',
        TRIGGER_TOKEN,
        updateRequest({ targetImage: TARGET, updaterTargetImage: null }),
      );
      expect(response.status).toBe(202);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://hlm-agent-updater:9091/trigger',
        expect.objectContaining({
          body: JSON.stringify({ targetImage: TARGET }),
        }),
      );
    } finally {
      restore();
    }
  });

  test('returns 400 for a floating updaterTargetImage instead of forwarding it', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response('{}', { status: 202 })));
    try {
      const response = await handleAgentUpdate(
        dockerStub,
        'http://hlm-agent-updater:9091/trigger',
        TRIGGER_TOKEN,
        updateRequest({ targetImage: TARGET, updaterTargetImage: 'ghcr.io/jaredglaser/homelab-manager-agent-updater:latest' }),
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('updaterTargetImage');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('returns 200 updateAvailable false when the agent is already current', async () => {
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ updateAvailable: false }), { status: 200 })));
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger', TRIGGER_TOKEN, updateRequest({ targetImage: TARGET }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.updateAvailable).toBe(false);
    } finally {
      restore();
    }
  });

  test('returns 400 for a floating tag instead of forwarding it', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response('{}', { status: 202 })));
    try {
      const response = await handleAgentUpdate(
        dockerStub,
        'http://hlm-agent-updater:9091/trigger',
        TRIGGER_TOKEN,
        updateRequest({ targetImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest' }),
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('digest');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('returns 400 for a malformed digest', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response('{}', { status: 202 })));
    try {
      const response = await handleAgentUpdate(
        dockerStub,
        'http://hlm-agent-updater:9091/trigger',
        TRIGGER_TOKEN,
        updateRequest({ targetImage: 'ghcr.io/jaredglaser/homelab-manager-agent@sha256:not-hex' }),
      );
      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('returns 400 when the body is missing', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response('{}', { status: 202 })));
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger', TRIGGER_TOKEN, updateRequest());
      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('returns 400 when the body is not JSON', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response('{}', { status: 202 })));
    try {
      const response = await handleAgentUpdate(
        dockerStub,
        'http://hlm-agent-updater:9091/trigger',
        TRIGGER_TOKEN,
        new Request('http://agent.local/agent/update', { method: 'POST', body: 'not json' }),
      );
      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('returns 503 with the pinned message when the updater is unreachable', async () => {
    const { restore } = withFetch(() => Promise.reject(new Error('connection refused')));
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger', TRIGGER_TOKEN, updateRequest({ targetImage: TARGET }));
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe('agent-updater sidecar is not reachable. The agent stack has no agent-updater container, or it is not listening.');
    } finally {
      restore();
    }
  });

  test('passes a plain-text sidecar failure through as the error message', async () => {
    const { restore } = withFetch(() => Promise.resolve(new Response('Update check failed. Verify the agent host can reach the image registry, then retry the update.', { status: 503 })));
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger', TRIGGER_TOKEN, updateRequest({ targetImage: TARGET }));
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error).toBe('Update check failed. Verify the agent host can reach the image registry, then retry the update.');
    } finally {
      restore();
    }
  });

  test('relays 409 when an update is already in progress', async () => {
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ error: 'An update is already in progress' }), { status: 409 })));
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger', TRIGGER_TOKEN, updateRequest({ targetImage: TARGET }));
      expect(response.status).toBe(409);
    } finally {
      restore();
    }
  });

  test('rejects an unexpected redirect from the updater', async () => {
    const { restore } = withFetch(() => Promise.resolve(new Response(null, { status: 302 })));
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger', TRIGGER_TOKEN, updateRequest({ targetImage: TARGET }));
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error).toContain('redirect');
    } finally {
      restore();
    }
  });

  test('maps a 200 with an unexpected body to 500', async () => {
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ updateAvailable: true, error: 'bad state' }), { status: 200 })));
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger', TRIGGER_TOKEN, updateRequest({ targetImage: TARGET }));
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('bad state');
    } finally {
      restore();
    }
  });

  test('passes through updater errors with their status', async () => {
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ error: 'registry unreachable' }), { status: 500 })));
    try {
      const response = await handleAgentUpdate(dockerStub, 'http://hlm-agent-updater:9091/trigger', TRIGGER_TOKEN, updateRequest({ targetImage: TARGET }));
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('registry unreachable');
    } finally {
      restore();
    }
  });
});

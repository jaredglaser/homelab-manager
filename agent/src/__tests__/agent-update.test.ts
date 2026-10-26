import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { handleAgentUpdate, resetUpdateInProgressGuard } from '../routes/agent-update';
import type Dockerode from 'dockerode';

beforeEach(() => {
  resetUpdateInProgressGuard();
});

const TARGET = 'ghcr.io/jaredglaser/homelab-manager-agent@sha256:' + 'a'.repeat(64);

function updateRequest(body?: unknown): Request {
  return new Request('http://agent.local/agent/update', {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface HelperCapture {
  createOptions: Record<string, unknown> | null;
  inspectError?: Error;
  createError?: Error;
}

function dockerStub(capture: HelperCapture, runningDigest: string | null = null): Dockerode {
  const container = {
    inspect: mock(() => {
      if (capture.inspectError) return Promise.reject(capture.inspectError);
      return Promise.resolve({
        Image: 'sha256:' + '1'.repeat(64),
        NetworkSettings: {
          Networks: {
            'agent-internal': { Aliases: ['hlm-agent'], IPAddress: '172.20.0.5' },
          },
        },
      });
    }),
  };
  return {
    getContainer: mock((_name: string) => container),
    getImage: mock((_id: string) => ({
      inspect: mock(() =>
        runningDigest
          ? Promise.resolve({ RepoDigests: ['ghcr.io/jaredglaser/homelab-manager-agent@' + runningDigest] })
          : Promise.resolve({ RepoDigests: [] }),
      ),
    })),
    createContainer: mock((options: Record<string, unknown>) => {
      if (capture.createError) return Promise.reject(capture.createError);
      capture.createOptions = options;
      return Promise.resolve({ start: mock(() => Promise.resolve()) });
    }),
  } as never as Dockerode;
}

describe('handleAgentUpdate', () => {
  test('returns 503 with actionable copy when Docker capability is not enabled', async () => {
    const response = await handleAgentUpdate(null, 'hlm-agent', 9090, updateRequest({ targetImage: TARGET }));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe(
      'Agent updates require Docker capability, which this agent does not have. Update it manually: run `docker compose pull && docker compose up -d` in the agent stack directory.',
    );
  });

  test('returns 400 for a floating tag', async () => {
    const capture: HelperCapture = { createOptions: null };
    const response = await handleAgentUpdate(
      dockerStub(capture),
      'hlm-agent',
      9090,
      updateRequest({ targetImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest' }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('digest');
    expect(capture.createOptions).toBeNull();
  });

  test('returns 400 for a malformed digest', async () => {
    const capture: HelperCapture = { createOptions: null };
    const response = await handleAgentUpdate(
      dockerStub(capture),
      'hlm-agent',
      9090,
      updateRequest({ targetImage: 'ghcr.io/jaredglaser/homelab-manager-agent@sha256:not-hex' }),
    );
    expect(response.status).toBe(400);
    expect(capture.createOptions).toBeNull();
  });

  test('returns 400 when the body is missing', async () => {
    const capture: HelperCapture = { createOptions: null };
    const response = await handleAgentUpdate(dockerStub(capture), 'hlm-agent', 9090, updateRequest());
    expect(response.status).toBe(400);
    expect(capture.createOptions).toBeNull();
  });

  test('returns 400 when the body is not JSON', async () => {
    const capture: HelperCapture = { createOptions: null };
    const response = await handleAgentUpdate(
      dockerStub(capture),
      'hlm-agent',
      9090,
      new Request('http://agent.local/agent/update', { method: 'POST', body: 'not json' }),
    );
    expect(response.status).toBe(400);
    expect(capture.createOptions).toBeNull();
  });

  test('returns 200 updateAvailable false when the agent already runs the target digest', async () => {
    const capture: HelperCapture = { createOptions: null };
    const response = await handleAgentUpdate(
      dockerStub(capture, 'sha256:' + 'a'.repeat(64)),
      'hlm-agent',
      9090,
      updateRequest({ targetImage: TARGET }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.updateAvailable).toBe(false);
    expect(capture.createOptions).toBeNull();
  });

  test('spawns the handover helper from the running image and answers 202', async () => {
    const capture: HelperCapture = { createOptions: null };
    const response = await handleAgentUpdate(
      dockerStub(capture, 'sha256:' + 'b'.repeat(64)),
      'hlm-agent',
      9090,
      updateRequest({ targetImage: TARGET }),
    );
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.started).toBe(true);
    expect(capture.createOptions).toMatchObject({
      Image: 'sha256:' + '1'.repeat(64),
      Cmd: ['bun', 'src/handover.ts'],
      HostConfig: { AutoRemove: true },
    });
    const env = (capture.createOptions as { Env: string[] }).Env;
    expect(env).toContain(`HLM_UPDATE_TARGET_IMAGE=${TARGET}`);
    expect(env).toContain('HLM_UPDATE_CONTAINER=hlm-agent');
    expect(env).toContain('HLM_UPDATE_AGENT_PORT=9090');
    const networks = (capture.createOptions as { NetworkingConfig: { EndpointsConfig: Record<string, unknown> } })
      .NetworkingConfig.EndpointsConfig;
    expect(Object.keys(networks)).toEqual(['agent-internal']);
    expect(networks['agent-internal']).toEqual({});
  });

  test('returns 409 when an update was already triggered inside the window', async () => {
    const capture: HelperCapture = { createOptions: null };
    const docker = dockerStub(capture, 'sha256:' + 'b'.repeat(64));
    const first = await handleAgentUpdate(docker, 'hlm-agent', 9090, updateRequest({ targetImage: TARGET }));
    expect(first.status).toBe(202);
    const second = await handleAgentUpdate(docker, 'hlm-agent', 9090, updateRequest({ targetImage: TARGET }));
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error).toBe('An update is already in progress');
  });

  test('maps a helper spawn failure to 500 with the reason', async () => {
    const capture: HelperCapture = { createOptions: null, createError: new Error('no space left on device') };
    const response = await handleAgentUpdate(
      dockerStub(capture, 'sha256:' + 'b'.repeat(64)),
      'hlm-agent',
      9090,
      updateRequest({ targetImage: TARGET }),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Could not start the agent update: no space left on device');
  });
});

import { describe, expect, test, mock, beforeAll } from 'bun:test';
import { handleHealth, handleInfo } from '../routes/health';

beforeAll(() => {
  console.error = mock(() => {});
});

function mockDockerClient() {
  return {
    version: mock(() =>
      Promise.resolve({
        Version: '24.0.7',
        ApiVersion: '1.43',
      })
    ),
  };
}

describe('handleHealth', () => {
  test('returns healthy status when Docker is available', async () => {
    const response = await handleHealth(mockDockerClient() as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'healthy' });
  });

  test('does not expose version or capability detail (endpoint is unauthenticated)', async () => {
    const response = await handleHealth(mockDockerClient() as any);
    const body = await response.json();

    expect(Object.keys(body)).toEqual(['status']);
  });

  test('returns unhealthy when Docker is not configured', async () => {
    const response = await handleHealth(null);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ status: 'unhealthy' });
  });

  test('returns unhealthy when Docker is unreachable', async () => {
    const mockDocker = {
      version: mock(() => Promise.reject(new Error('Connection refused'))),
    };

    const response = await handleHealth(mockDocker as any);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ status: 'unhealthy' });
  });
});

describe('handleInfo', () => {
  test('reports the resolved agent image', async () => {
    const response = await handleInfo(mockDockerClient() as any, async () => ({
      image: 'ghcr.io/jaredglaser/homelab-manager-agent:dev',
      tag: 'dev',
    }));
    const body = await response.json();

    expect(body.agentImage).toBe('ghcr.io/jaredglaser/homelab-manager-agent:dev');
    expect(body.agentImageTag).toBe('dev');
  });

  test('reports null image fields when the agent could not determine its image', async () => {
    const response = await handleInfo(mockDockerClient() as any, async () => ({ image: null, tag: null }));
    const body = await response.json();

    expect(body.agentImage).toBeNull();
    expect(body.agentImageTag).toBeNull();
  });

  test('reports null image fields when no image was resolved at all', async () => {
    const response = await handleInfo(mockDockerClient() as any);
    const body = await response.json();

    expect(body.agentImage).toBeNull();
    expect(body.agentImageTag).toBeNull();
  });

  test('reports the running agent image digest', async () => {
    const response = await handleInfo(mockDockerClient() as any, undefined, async () => 'sha256:' + 'c'.repeat(64));
    const body = await response.json();

    expect(body.agentImageDigest).toBe('sha256:' + 'c'.repeat(64));
  });

  test('reports a null agent image digest when the agent cannot inspect itself', async () => {
    const response = await handleInfo(mockDockerClient() as any, undefined);
    const body = await response.json();

    expect(body.agentImageDigest).toBeNull();
  });

  test('resolves the image per request, so a later call can recover from an early failure', async () => {
    let call = 0;
    const resolveImage = async () => {
      call += 1;
      return call === 1 ? { image: null, tag: null } : { image: 'ghcr.io/x/agent:dev', tag: 'dev' };
    };

    const first = await (await handleInfo(mockDockerClient() as any, resolveImage)).json();
    const second = await (await handleInfo(mockDockerClient() as any, resolveImage)).json();

    expect(first.agentImageTag).toBeNull();
    expect(second.agentImageTag).toBe('dev');
  });

  test('reports the AGENT_SOURCE_HASH build stamp, and null when the image has none', async () => {
    const original = process.env.AGENT_SOURCE_HASH;
    try {
      process.env.AGENT_SOURCE_HASH = 'e'.repeat(64);
      expect((await (await handleInfo(mockDockerClient() as any)).json()).agentSourceHash).toBe('e'.repeat(64));
      process.env.AGENT_SOURCE_HASH = '';
      expect((await (await handleInfo(mockDockerClient() as any)).json()).agentSourceHash).toBeNull();
    } finally {
      if (original === undefined) delete process.env.AGENT_SOURCE_HASH;
      else process.env.AGENT_SOURCE_HASH = original;
    }
  });

  test('prefers the AGENT_VERSION build stamp over package.json', async () => {
    const original = process.env.AGENT_VERSION;
    process.env.AGENT_VERSION = '1.2.3';
    try {
      const response = await handleInfo(mockDockerClient() as any);
      const body = await response.json();

      expect(body.agentVersion).toBe('1.2.3');
    } finally {
      if (original === undefined) delete process.env.AGENT_VERSION;
      else process.env.AGENT_VERSION = original;
    }
  });

  test('falls back to the short commit hash when AGENT_VERSION is unset', async () => {
    const original = process.env.AGENT_VERSION;
    delete process.env.AGENT_VERSION;
    try {
      const response = await handleInfo(mockDockerClient() as any);
      const body = await response.json();
      const expected = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD']).stdout.toString().trim();

      expect(body.agentVersion).toBe(expected);
    } finally {
      if (original !== undefined) process.env.AGENT_VERSION = original;
    }
  });

  test('spawns git once for the version, not per request', async () => {
    const original = process.env.AGENT_VERSION;
    delete process.env.AGENT_VERSION;
    const docker = mockDockerClient() as unknown as Parameters<typeof handleInfo>[0];
    try {
      // Warm the revision first: the initial resolution may legitimately spawn.
      await (await handleInfo(docker)).json();

      const spawned: string[][] = [];
      const realSpawnSync = Bun.spawnSync;
      Bun.spawnSync = ((command: string[]) => {
        spawned.push(command);
        return realSpawnSync(command);
      }) as typeof Bun.spawnSync;
      try {
        await (await handleInfo(docker)).json();
        await (await handleInfo(docker)).json();
      } finally {
        Bun.spawnSync = realSpawnSync;
      }

      expect(spawned.filter((command) => command.includes('rev-parse'))).toEqual([]);
    } finally {
      if (original !== undefined) process.env.AGENT_VERSION = original;
    }
  });

  test('reports the Docker capability and no ZFS capability', async () => {
    const response = await handleInfo(mockDockerClient() as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    const expected = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD']).stdout.toString().trim();
    expect(body.agentVersion).toBe(expected);
    expect(body.capabilities).toEqual({
      docker: { available: true, version: '24.0.7', apiVersion: '1.43' },
    });
  });

  test('returns unhealthy when Docker is not configured', async () => {
    const response = await handleInfo(null);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.capabilities).toEqual({ docker: { available: false } });
  });

  test('returns unhealthy when Docker is unreachable', async () => {
    const mockDocker = {
      version: mock(() => Promise.reject(new Error('Connection refused'))),
    };

    const response = await handleInfo(mockDocker as any);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.capabilities).toEqual({ docker: { available: false } });
  });
});

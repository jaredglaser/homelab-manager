import { describe, expect, test, mock, beforeAll } from 'bun:test';
import { handleHealth, handleInfo } from '../routes/health';
import type { ZfsCapabilities } from '../lib/zfs-capabilities';
import pkg from '../../package.json';

beforeAll(() => {
  console.error = mock(() => {});
});

const zfsAvailable: ZfsCapabilities = {
  available: true,
  version: '2.2.2',
  tier: 1,
  permissions: [],
};

const zfsWithSnapshots: ZfsCapabilities = {
  available: true,
  version: '2.2.2',
  tier: 2,
  permissions: ['destroy', 'hold', 'rollback', 'send', 'snapshot'],
};

const zfsUnavailable: ZfsCapabilities = {
  available: false,
  tier: 0,
  permissions: [],
};

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
    const response = await handleHealth(mockDockerClient() as any, zfsUnavailable);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'healthy' });
  });

  test('returns healthy status when only ZFS is available', async () => {
    const response = await handleHealth(null, zfsAvailable);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'healthy' });
  });

  test('does not expose version or capability detail (endpoint is unauthenticated)', async () => {
    const response = await handleHealth(mockDockerClient() as any, zfsWithSnapshots);
    const body = await response.json();

    expect(Object.keys(body)).toEqual(['status']);
  });

  test('returns unhealthy when neither capability is available', async () => {
    const response = await handleHealth(null, zfsUnavailable);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ status: 'unhealthy' });
  });

  test('returns unhealthy when Docker unreachable and no ZFS', async () => {
    const mockDocker = {
      version: mock(() => Promise.reject(new Error('Connection refused'))),
    };

    const response = await handleHealth(mockDocker as any, zfsUnavailable);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ status: 'unhealthy' });
  });
});

describe('handleInfo', () => {
  test('reports the resolved agent image', async () => {
    const response = await handleInfo(mockDockerClient() as any, zfsAvailable, async () => ({
      image: 'ghcr.io/jaredglaser/homelab-manager-agent:dev',
      tag: 'dev',
    }));
    const body = await response.json();

    expect(body.agentImage).toBe('ghcr.io/jaredglaser/homelab-manager-agent:dev');
    expect(body.agentImageTag).toBe('dev');
  });

  test('reports null image fields when the agent could not determine its image', async () => {
    const response = await handleInfo(mockDockerClient() as any, zfsAvailable, async () => ({ image: null, tag: null }));
    const body = await response.json();

    expect(body.agentImage).toBeNull();
    expect(body.agentImageTag).toBeNull();
  });

  test('reports null image fields when no image was resolved at all', async () => {
    const response = await handleInfo(mockDockerClient() as any, zfsAvailable);
    const body = await response.json();

    expect(body.agentImage).toBeNull();
    expect(body.agentImageTag).toBeNull();
  });

  test('resolves the image per request, so a later call can recover from an early failure', async () => {
    let call = 0;
    const resolveImage = async () => {
      call += 1;
      return call === 1 ? { image: null, tag: null } : { image: 'ghcr.io/x/agent:dev', tag: 'dev' };
    };

    const first = await (await handleInfo(mockDockerClient() as any, zfsAvailable, resolveImage)).json();
    const second = await (await handleInfo(mockDockerClient() as any, zfsAvailable, resolveImage)).json();

    expect(first.agentImageTag).toBeNull();
    expect(second.agentImageTag).toBe('dev');
  });

  test('reports Docker and ZFS capabilities when both available', async () => {
    const response = await handleInfo(mockDockerClient() as any, zfsAvailable);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.agentVersion).toBe(pkg.version);
    expect(body.capabilities.docker).toEqual({
      available: true,
      version: '24.0.7',
      apiVersion: '1.43',
    });
    expect(body.capabilities.zfs).toEqual({
      available: true,
      version: '2.2.2',
      tier: 1,
      permissions: [],
    });
  });

  test('reports only Docker when ZFS unavailable', async () => {
    const response = await handleInfo(mockDockerClient() as any, zfsUnavailable);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.capabilities.docker.available).toBe(true);
    expect(body.capabilities.zfs).toEqual({ available: false });
  });

  test('reports only ZFS when Docker is null', async () => {
    const response = await handleInfo(null, zfsWithSnapshots);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.capabilities.docker).toEqual({ available: false });
    expect(body.capabilities.zfs).toEqual({
      available: true,
      version: '2.2.2',
      tier: 2,
      permissions: ['destroy', 'hold', 'rollback', 'send', 'snapshot'],
    });
  });

  test('returns unhealthy when neither available', async () => {
    const response = await handleInfo(null, zfsUnavailable);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.capabilities.docker).toEqual({ available: false });
    expect(body.capabilities.zfs).toEqual({ available: false });
  });

  test('returns healthy with Docker when no ZFS capabilities provided', async () => {
    const response = await handleInfo(mockDockerClient() as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.capabilities.docker.available).toBe(true);
    expect(body.capabilities.zfs).toEqual({ available: false });
  });

  test('returns unhealthy when Docker unreachable and no ZFS', async () => {
    const mockDocker = {
      version: mock(() => Promise.reject(new Error('Connection refused'))),
    };

    const response = await handleInfo(mockDocker as any, zfsUnavailable);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.capabilities.docker).toEqual({ available: false });
    expect(body.capabilities.zfs).toEqual({ available: false });
  });
});

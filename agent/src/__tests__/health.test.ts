import { describe, expect, test, mock, beforeAll } from 'bun:test';
import { handleHealth } from '../routes/health';
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

describe('handleHealth', () => {
  test('reports Docker and ZFS capabilities when both available', async () => {
    const mockDocker = {
      version: mock(() =>
        Promise.resolve({
          Version: '24.0.7',
          ApiVersion: '1.43',
        })
      ),
    };

    const response = await handleHealth(mockDocker as any, zfsAvailable);
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
    const mockDocker = {
      version: mock(() =>
        Promise.resolve({
          Version: '24.0.7',
          ApiVersion: '1.43',
        })
      ),
    };

    const response = await handleHealth(mockDocker as any, zfsUnavailable);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.capabilities.docker.available).toBe(true);
    expect(body.capabilities.zfs).toEqual({ available: false });
  });

  test('reports only ZFS when Docker is null', async () => {
    const response = await handleHealth(null, zfsWithSnapshots);
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
    const response = await handleHealth(null, zfsUnavailable);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.capabilities.docker).toEqual({ available: false });
    expect(body.capabilities.zfs).toEqual({ available: false });
  });

  test('returns healthy with Docker when no ZFS capabilities provided', async () => {
    const mockDocker = {
      version: mock(() =>
        Promise.resolve({
          Version: '24.0.7',
          ApiVersion: '1.43',
        })
      ),
    };

    const response = await handleHealth(mockDocker as any);
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

    const response = await handleHealth(mockDocker as any, zfsUnavailable);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.capabilities.docker).toEqual({ available: false });
    expect(body.capabilities.zfs).toEqual({ available: false });
  });

});

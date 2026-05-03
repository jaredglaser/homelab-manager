import { describe, test, expect, mock, afterEach } from 'bun:test';
import {
  toHostListItem,
  retryHealthCheck,
  getAgentImage,
  getAgentUpdaterImage,
} from '../host-utils';
import type { HealthCheckOutcome } from '../host-utils';
import type { ManagedHost } from '../../database/repositories/host-repository';

describe('toHostListItem', () => {
  const baseRow: ManagedHost = {
    id: 1,
    name: 'test-host',
    agentUrl: 'http://192.168.1.10:9090',
    capabilities: { docker: true },
    agentVersion: '1.0.0',
    status: 'healthy',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  };

  test('maps DB row to HostListItem', () => {
    const item = toHostListItem(baseRow);
    expect(item).toEqual({
      id: 1,
      name: 'test-host',
      agentUrl: 'http://192.168.1.10:9090',
      capabilities: { docker: true },
      agentVersion: '1.0.0',
      status: 'healthy',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  test('applies agentVersion override', () => {
    const item = toHostListItem(baseRow, { agentVersion: '2.0.0' });
    expect(item.agentVersion).toBe('2.0.0');
  });

  test('applies null agentVersion override', () => {
    const item = toHostListItem(baseRow, { agentVersion: null });
    expect(item.agentVersion).toBeNull();
  });

  test('applies status override', () => {
    const item = toHostListItem(baseRow, { status: 'error' });
    expect(item.status).toBe('error');
  });

  test('applies both overrides', () => {
    const item = toHostListItem(baseRow, { agentVersion: '3.0.0', status: 'pending' });
    expect(item.agentVersion).toBe('3.0.0');
    expect(item.status).toBe('pending');
  });

  test('preserves original values when no overrides', () => {
    const item = toHostListItem({ ...baseRow, agentVersion: null, status: 'unhealthy' });
    expect(item.agentVersion).toBeNull();
    expect(item.status).toBe('unhealthy');
  });

  test('converts dates to ISO strings', () => {
    const item = toHostListItem(baseRow);
    expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(item.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('defaults capabilities to empty object when undefined', () => {
    const row = { ...baseRow, capabilities: undefined as unknown as ManagedHost['capabilities'] };
    const item = toHostListItem(row);
    expect(item.capabilities).toEqual({});
  });

  test('maps capabilities with docker and zfs', () => {
    const row = { ...baseRow, capabilities: { docker: true, zfs: true } };
    const item = toHostListItem(row);
    expect(item.capabilities).toEqual({ docker: true, zfs: true });
  });
});

describe('retryHealthCheck', () => {
  test('returns immediately on first success', async () => {
    const checkFn = mock<(url: string) => Promise<HealthCheckOutcome>>()
      .mockResolvedValueOnce({ healthy: true, version: '1.0.0' });

    const result = await retryHealthCheck(checkFn, 'http://agent:9090', [0]);
    expect(result.healthy).toBe(true);
    if (result.healthy) expect(result.version).toBe('1.0.0');
    expect(checkFn).toHaveBeenCalledTimes(1);
    expect(checkFn).toHaveBeenCalledWith('http://agent:9090');
  });

  test('retries on failure and returns success', async () => {
    const checkFn = mock<(url: string) => Promise<HealthCheckOutcome>>()
      .mockResolvedValueOnce({ healthy: false, error: 'connection refused' })
      .mockResolvedValueOnce({ healthy: true, version: '1.0.0' });

    const result = await retryHealthCheck(checkFn, 'http://agent:9090', [0, 0]);
    expect(result.healthy).toBe(true);
    expect(checkFn).toHaveBeenCalledTimes(2);
  });

  test('returns last failure after all retries exhausted', async () => {
    const checkFn = mock<(url: string) => Promise<HealthCheckOutcome>>()
      .mockResolvedValueOnce({ healthy: false, error: 'attempt 1' })
      .mockResolvedValueOnce({ healthy: false, error: 'attempt 2' })
      .mockResolvedValueOnce({ healthy: false, error: 'attempt 3' });

    const result = await retryHealthCheck(checkFn, 'http://agent:9090', [0, 0, 0]);
    expect(result.healthy).toBe(false);
    if (!result.healthy) expect(result.error).toBe('attempt 3');
    expect(checkFn).toHaveBeenCalledTimes(3);
  });

  test('returns default failure when delays array is empty', async () => {
    const checkFn = mock<(url: string) => Promise<HealthCheckOutcome>>();

    const result = await retryHealthCheck(checkFn, 'http://agent:9090', []);
    expect(result.healthy).toBe(false);
    if (!result.healthy) expect(result.error).toBe('Health check not attempted');
    expect(checkFn).toHaveBeenCalledTimes(0);
  });

  test('stops retrying after first success', async () => {
    const checkFn = mock<(url: string) => Promise<HealthCheckOutcome>>()
      .mockResolvedValueOnce({ healthy: false, error: 'fail' })
      .mockResolvedValueOnce({ healthy: true })
      .mockResolvedValueOnce({ healthy: false, error: 'should not reach' });

    const result = await retryHealthCheck(checkFn, 'http://agent:9090', [0, 0, 0]);
    expect(result.healthy).toBe(true);
    expect(checkFn).toHaveBeenCalledTimes(2);
  });
});

describe('getAgentImage', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalEnv;
    }
  });

  // TODO: restore dev-variant test once CI/local builds publish a :dev tag.
  // test('returns dev image in development', () => {
  //   process.env.NODE_ENV = 'development';
  //   expect(getAgentImage()).toBe('homelab-manager-agent:dev');
  // });

  test('returns prod image in production', () => {
    process.env.NODE_ENV = 'production';
    expect(getAgentImage()).toBe('ghcr.io/jaredglaser/homelab-manager-agent:latest');
  });

  test('returns prod image when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    expect(getAgentImage()).toBe('ghcr.io/jaredglaser/homelab-manager-agent:latest');
  });

  test('returns prod image even in development (dev variant disabled)', () => {
    process.env.NODE_ENV = 'development';
    expect(getAgentImage()).toBe('ghcr.io/jaredglaser/homelab-manager-agent:latest');
  });
});

describe('getAgentUpdaterImage', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalEnv;
    }
  });

  test('returns prod image in production', () => {
    process.env.NODE_ENV = 'production';
    expect(getAgentUpdaterImage()).toBe('ghcr.io/jaredglaser/homelab-manager-agent-updater:latest');
  });

  test('returns prod image when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    expect(getAgentUpdaterImage()).toBe('ghcr.io/jaredglaser/homelab-manager-agent-updater:latest');
  });

  test('returns prod image even in development (dev variant disabled)', () => {
    process.env.NODE_ENV = 'development';
    expect(getAgentUpdaterImage()).toBe('ghcr.io/jaredglaser/homelab-manager-agent-updater:latest');
  });
});

import { describe, test, expect, mock, afterEach } from 'bun:test';
import {
  parseDockerodeConfig,
  toHostListItem,
  retryHealthCheck,
  getAgentImage,
} from '@/lib/hosts/host-utils';
import type { HealthCheckOutcome } from '@/lib/hosts/host-utils';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';

describe('parseDockerodeConfig', () => {
  test('parses tcp:// URL', () => {
    const config = parseDockerodeConfig('tcp://192.168.1.10:2375');
    expect(config).toEqual({ host: '192.168.1.10', port: 2375, protocol: 'http' });
  });

  test('parses http:// URL', () => {
    const config = parseDockerodeConfig('http://myhost:2376');
    expect(config).toEqual({ host: 'myhost', port: 2376, protocol: 'http' });
  });

  test('parses https:// URL', () => {
    const config = parseDockerodeConfig('https://secure-host:2376');
    expect(config).toEqual({ host: 'secure-host', port: 2376, protocol: 'https' });
  });

  test('defaults port to 2375 when not specified', () => {
    const config = parseDockerodeConfig('http://myhost');
    expect(config.port).toBe(2375);
  });

  test('handles IPv6 hostname', () => {
    const config = parseDockerodeConfig('tcp://[::1]:2375');
    // URL parser preserves brackets around IPv6 addresses
    expect(config.host).toBe('[::1]');
    expect(config.port).toBe(2375);
  });

  test('throws on invalid URL', () => {
    expect(() => parseDockerodeConfig('not-a-url')).toThrow();
  });
});

describe('toHostListItem', () => {
  const baseRow: ManagedHost = {
    id: 1,
    name: 'test-host',
    agent_url: 'http://192.168.1.10:9090',
    agent_token_hash: 'hash',
    agent_token: 'token',
    socket_proxy_url: 'tcp://192.168.1.10:2375',
    agent_version: '1.0.0',
    status: 'healthy',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-02T00:00:00Z'),
  };

  test('maps DB row to HostListItem', () => {
    const item = toHostListItem(baseRow);
    expect(item).toEqual({
      id: 1,
      name: 'test-host',
      agentUrl: 'http://192.168.1.10:9090',
      socketProxyUrl: 'tcp://192.168.1.10:2375',
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
    const item = toHostListItem({ ...baseRow, agent_version: null, status: 'unhealthy' });
    expect(item.agentVersion).toBeNull();
    expect(item.status).toBe('unhealthy');
  });

  test('converts dates to ISO strings', () => {
    const item = toHostListItem(baseRow);
    expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(item.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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

  test('returns dev image in development', () => {
    process.env.NODE_ENV = 'development';
    expect(getAgentImage()).toBe('homelab-manager-agent:dev');
  });

  test('returns prod image in production', () => {
    process.env.NODE_ENV = 'production';
    expect(getAgentImage()).toBe('ghcr.io/homelab-manager/agent:latest');
  });

  test('returns prod image when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    expect(getAgentImage()).toBe('ghcr.io/homelab-manager/agent:latest');
  });
});

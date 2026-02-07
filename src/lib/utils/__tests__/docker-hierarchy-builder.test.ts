import { describe, it, expect } from 'bun:test';
import { buildDockerHierarchy } from '../docker-hierarchy-builder';
import type { DockerStatsFromDB } from '@/lib/transformers/docker-transformer';

describe('buildDockerHierarchy', () => {
  // Helper to create mock Docker stats
  function createMockStats(
    hostName: string,
    containerId: string,
    containerName: string,
    overrides?: Partial<DockerStatsFromDB['rates'] & DockerStatsFromDB['memory_stats']>
  ): DockerStatsFromDB {
    return {
      id: `${hostName}/${containerId}`,
      name: containerName,
      timestamp: new Date(),
      rates: {
        cpuPercent: overrides?.cpuPercent ?? 10,
        memoryPercent: overrides?.memoryPercent ?? 50,
        networkRxBytesPerSec: overrides?.networkRxBytesPerSec ?? 1000,
        networkTxBytesPerSec: overrides?.networkTxBytesPerSec ?? 500,
        blockIoReadBytesPerSec: overrides?.blockIoReadBytesPerSec ?? 2000,
        blockIoWriteBytesPerSec: overrides?.blockIoWriteBytesPerSec ?? 1000,
      },
      memory_stats: {
        usage: overrides?.usage ?? 1073741824, // 1GB
        limit: overrides?.limit ?? 2147483648, // 2GB
      },
    };
  }

  it('should return empty hierarchy for empty stats', () => {
    const hierarchy = buildDockerHierarchy([]);
    expect(hierarchy.size).toBe(0);
  });

  it('should group containers by host', () => {
    const stats = [
      createMockStats('host1', 'container1', 'nginx'),
      createMockStats('host1', 'container2', 'redis'),
      createMockStats('host2', 'container3', 'postgres'),
    ];

    const hierarchy = buildDockerHierarchy(stats);

    expect(hierarchy.size).toBe(2);
    expect(hierarchy.has('host1')).toBe(true);
    expect(hierarchy.has('host2')).toBe(true);

    expect(hierarchy.get('host1')!.containers.size).toBe(2);
    expect(hierarchy.get('host2')!.containers.size).toBe(1);
  });

  it('should calculate correct container count', () => {
    const stats = [
      createMockStats('host1', 'c1', 'nginx'),
      createMockStats('host1', 'c2', 'redis'),
      createMockStats('host1', 'c3', 'postgres'),
    ];

    const hierarchy = buildDockerHierarchy(stats);
    const host = hierarchy.get('host1')!;

    expect(host.aggregated.containerCount).toBe(3);
  });

  it('should sum CPU percentages across containers', () => {
    const stats = [
      createMockStats('host1', 'c1', 'nginx', { cpuPercent: 25 }),
      createMockStats('host1', 'c2', 'redis', { cpuPercent: 15 }),
      createMockStats('host1', 'c3', 'postgres', { cpuPercent: 60 }),
    ];

    const hierarchy = buildDockerHierarchy(stats);
    const host = hierarchy.get('host1')!;

    expect(host.aggregated.cpuPercent).toBe(100);
  });

  it('should sum memory usage and limits', () => {
    const stats = [
      createMockStats('host1', 'c1', 'nginx', { usage: 1000, limit: 2000 }),
      createMockStats('host1', 'c2', 'redis', { usage: 500, limit: 1000 }),
    ];

    const hierarchy = buildDockerHierarchy(stats);
    const host = hierarchy.get('host1')!;

    expect(host.aggregated.memoryUsage).toBe(1500);
    expect(host.aggregated.memoryLimit).toBe(3000);
  });

  it('should calculate weighted average memory percentage', () => {
    const stats = [
      createMockStats('host1', 'c1', 'nginx', { usage: 1000, limit: 2000 }),
      createMockStats('host1', 'c2', 'redis', { usage: 500, limit: 1000 }),
    ];

    const hierarchy = buildDockerHierarchy(stats);
    const host = hierarchy.get('host1')!;

    // (1500 / 3000) * 100 = 50%
    expect(host.aggregated.memoryPercent).toBe(50);
  });

  it('should handle zero memory limit gracefully', () => {
    const stats = [
      createMockStats('host1', 'c1', 'nginx', { usage: 0, limit: 0 }),
    ];

    const hierarchy = buildDockerHierarchy(stats);
    const host = hierarchy.get('host1')!;

    expect(host.aggregated.memoryPercent).toBe(0);
  });

  it('should sum network I/O rates', () => {
    const stats = [
      createMockStats('host1', 'c1', 'nginx', {
        networkRxBytesPerSec: 1000,
        networkTxBytesPerSec: 500,
      }),
      createMockStats('host1', 'c2', 'redis', {
        networkRxBytesPerSec: 2000,
        networkTxBytesPerSec: 1500,
      }),
    ];

    const hierarchy = buildDockerHierarchy(stats);
    const host = hierarchy.get('host1')!;

    expect(host.aggregated.networkRxBytesPerSec).toBe(3000);
    expect(host.aggregated.networkTxBytesPerSec).toBe(2000);
  });

  it('should sum block I/O rates', () => {
    const stats = [
      createMockStats('host1', 'c1', 'nginx', {
        blockIoReadBytesPerSec: 1000,
        blockIoWriteBytesPerSec: 500,
      }),
      createMockStats('host1', 'c2', 'redis', {
        blockIoReadBytesPerSec: 3000,
        blockIoWriteBytesPerSec: 2000,
      }),
    ];

    const hierarchy = buildDockerHierarchy(stats);
    const host = hierarchy.get('host1')!;

    expect(host.aggregated.blockIoReadBytesPerSec).toBe(4000);
    expect(host.aggregated.blockIoWriteBytesPerSec).toBe(2500);
  });

  it('should preserve container data in hierarchy', () => {
    const stats = [createMockStats('host1', 'abc123', 'my-container')];

    const hierarchy = buildDockerHierarchy(stats);
    const host = hierarchy.get('host1')!;
    const container = host.containers.get('host1/abc123')!;

    expect(container.data.name).toBe('my-container');
    expect(container.data.id).toBe('host1/abc123');
  });

  it('should store hostName in host stats', () => {
    const stats = [createMockStats('my-docker-host', 'c1', 'nginx')];

    const hierarchy = buildDockerHierarchy(stats);
    const host = hierarchy.get('my-docker-host')!;

    expect(host.hostName).toBe('my-docker-host');
  });

  it('should handle multiple hosts with different container counts', () => {
    const stats = [
      createMockStats('host1', 'c1', 'nginx'),
      createMockStats('host1', 'c2', 'redis'),
      createMockStats('host2', 'c3', 'postgres'),
      createMockStats('host2', 'c4', 'mysql'),
      createMockStats('host2', 'c5', 'mongodb'),
      createMockStats('host3', 'c6', 'rabbitmq'),
    ];

    const hierarchy = buildDockerHierarchy(stats);

    expect(hierarchy.get('host1')!.aggregated.containerCount).toBe(2);
    expect(hierarchy.get('host2')!.aggregated.containerCount).toBe(3);
    expect(hierarchy.get('host3')!.aggregated.containerCount).toBe(1);
  });

  it('should throw error for invalid entity path format', () => {
    const stats: DockerStatsFromDB[] = [
      {
        id: 'invalid-no-slash', // Missing slash
        name: 'test',
        timestamp: new Date(),
        rates: {
          cpuPercent: 0,
          memoryPercent: 0,
          networkRxBytesPerSec: 0,
          networkTxBytesPerSec: 0,
          blockIoReadBytesPerSec: 0,
          blockIoWriteBytesPerSec: 0,
        },
        memory_stats: { usage: 0, limit: 0 },
      },
    ];

    expect(() => buildDockerHierarchy(stats)).toThrow(
      'Invalid entity path format: invalid-no-slash'
    );
  });
});

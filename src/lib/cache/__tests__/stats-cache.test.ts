import { describe, it, expect, beforeEach } from 'bun:test';
import type { DockerStatsFromDB } from '@/lib/transformers/docker-transformer';

// We need to test the StatsCache class directly, but it's exported as a singleton.
// Re-import the module to get a fresh class each time by testing the exported instance.
// Since the cache is a singleton, we'll use its clear() + updateDocker() methods.
import { statsCache } from '../stats-cache';

function createMockDockerStat(
  id: string,
  timestamp: Date,
  overrides?: Partial<DockerStatsFromDB>
): DockerStatsFromDB {
  return {
    id,
    name: id.split('/')[1] ?? id,
    image: 'nginx:latest',
    icon: null,
    stale: false,
    timestamp,
    rates: {
      cpuPercent: 10,
      memoryPercent: 50,
      networkRxBytesPerSec: 1000,
      networkTxBytesPerSec: 500,
      blockIoReadBytesPerSec: 2000,
      blockIoWriteBytesPerSec: 1000,
    },
    memory_stats: {
      usage: 1073741824,
      limit: 2147483648,
    },
    ...overrides,
  };
}

describe('StatsCache.updateDocker', () => {
  beforeEach(() => {
    statsCache.clear();
  });

  it('should add fresh entries on first update', () => {
    const now = new Date();
    const freshStats = new Map([
      ['host1/c1', createMockDockerStat('host1/c1', now)],
      ['host1/c2', createMockDockerStat('host1/c2', now)],
    ]);

    statsCache.updateDocker(freshStats);
    const result = statsCache.getDocker();

    expect(result).toHaveLength(2);
    expect(result.every(s => s.stale === false)).toBe(true);
  });

  it('should mark missing entries as stale', () => {
    const now = new Date();

    // First update: two containers
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', now)],
      ['host1/c2', createMockDockerStat('host1/c2', now)],
    ]));

    // Second update: only one container
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', now)],
    ]));

    const result = statsCache.getDocker();
    expect(result).toHaveLength(2);

    const c1 = result.find(s => s.id === 'host1/c1')!;
    const c2 = result.find(s => s.id === 'host1/c2')!;
    expect(c1.stale).toBe(false);
    expect(c2.stale).toBe(true);
  });

  it('should restore stale entries to fresh when they reappear', () => {
    const now = new Date();

    // First update: two containers
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', now)],
      ['host1/c2', createMockDockerStat('host1/c2', now)],
    ]));

    // Second update: c2 missing (becomes stale)
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', now)],
    ]));

    // Third update: c2 returns
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', now)],
      ['host1/c2', createMockDockerStat('host1/c2', now)],
    ]));

    const result = statsCache.getDocker();
    expect(result).toHaveLength(2);
    expect(result.every(s => s.stale === false)).toBe(true);
  });

  it('should remove stale entries older than 5 minutes', () => {
    const fiveMinutesAgo = new Date(Date.now() - 6 * 60 * 1000); // 6 minutes ago
    const now = new Date();

    // First update: one old container and one fresh
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', now)],
      ['host1/c2', createMockDockerStat('host1/c2', fiveMinutesAgo)],
    ]));

    // Second update: only c1 (c2 is now stale with old timestamp)
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', now)],
    ]));

    const result = statsCache.getDocker();
    // c2 should be removed because its timestamp is >5 minutes old
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('host1/c1');
  });

  it('should keep stale entries with recent timestamps', () => {
    const now = new Date();

    // First update: two containers
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', now)],
      ['host1/c2', createMockDockerStat('host1/c2', now)],
    ]));

    // Second update: only c1 (c2 has recent timestamp, should stay as stale)
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', now)],
    ]));

    const result = statsCache.getDocker();
    expect(result).toHaveLength(2);

    const c2 = result.find(s => s.id === 'host1/c2')!;
    expect(c2.stale).toBe(true);
  });

  it('should mark all entries stale when empty fresh map is provided', () => {
    const now = new Date();

    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', now)],
    ]));

    // Empty update
    statsCache.updateDocker(new Map());

    const result = statsCache.getDocker();
    expect(result).toHaveLength(1);
    expect(result[0].stale).toBe(true);
  });

  it('should always set stale=false on fresh entries even if previously stale', () => {
    const now = new Date();

    // Seed with a manually stale entry
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', now, { stale: true })],
    ]));

    // Fresh update includes it
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', now)],
    ]));

    const result = statsCache.getDocker();
    expect(result[0].stale).toBe(false);
  });
});

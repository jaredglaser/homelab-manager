import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { DockerStatsFromDB } from '@/lib/transformers/docker-transformer';
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
  let nowMs: number;
  let dateNowSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    statsCache.clear();
    nowMs = 1_000_000_000;
    dateNowSpy = spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  const ts = () => new Date(nowMs);

  it('should add fresh entries on first update', () => {
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', ts())],
      ['host1/c2', createMockDockerStat('host1/c2', ts())],
    ]));

    const result = statsCache.getDocker();
    expect(result).toHaveLength(2);
    expect(result.every(s => s.stale === false)).toBe(true);
  });

  it('should keep missing entries fresh during grace period', () => {
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', ts())],
      ['host1/c2', createMockDockerStat('host1/c2', ts())],
    ]));

    nowMs += 5_000; // 5s later — within 15s grace period
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', ts())],
    ]));

    const result = statsCache.getDocker();
    expect(result).toHaveLength(2);
    expect(result.find(s => s.id === 'host1/c1')!.stale).toBe(false);
    expect(result.find(s => s.id === 'host1/c2')!.stale).toBe(false);
  });

  it('should mark entries stale after grace period expires', () => {
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', ts())],
      ['host1/c2', createMockDockerStat('host1/c2', ts())],
    ]));

    nowMs += 16_000; // 16s later — past 15s grace period
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', ts())],
    ]));

    const result = statsCache.getDocker();
    expect(result).toHaveLength(2);
    expect(result.find(s => s.id === 'host1/c1')!.stale).toBe(false);
    expect(result.find(s => s.id === 'host1/c2')!.stale).toBe(true);
  });

  it('should restore stale entries to fresh when they reappear', () => {
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', ts())],
      ['host1/c2', createMockDockerStat('host1/c2', ts())],
    ]));

    nowMs += 16_000;
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', ts())],
    ]));
    expect(statsCache.getDocker().find(s => s.id === 'host1/c2')!.stale).toBe(true);

    nowMs += 1_000;
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', ts())],
      ['host1/c2', createMockDockerStat('host1/c2', ts())],
    ]));

    const result = statsCache.getDocker();
    expect(result).toHaveLength(2);
    expect(result.every(s => s.stale === false)).toBe(true);
  });

  it('should remove entries after expiry (5 minutes)', () => {
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', ts())],
      ['host1/c2', createMockDockerStat('host1/c2', ts())],
    ]));

    nowMs += 6 * 60 * 1000; // 6 minutes later
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', ts())],
    ]));

    const result = statsCache.getDocker();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('host1/c1');
  });

  it('should mark all entries stale after grace period with empty update', () => {
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', ts())],
    ]));

    nowMs += 16_000;
    statsCache.updateDocker(new Map());

    const result = statsCache.getDocker();
    expect(result).toHaveLength(1);
    expect(result[0].stale).toBe(true);
  });

  it('should keep entries fresh with empty update within grace period', () => {
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', ts())],
    ]));

    nowMs += 5_000;
    statsCache.updateDocker(new Map());

    const result = statsCache.getDocker();
    expect(result).toHaveLength(1);
    expect(result[0].stale).toBe(false);
  });

  it('should always set stale=false on fresh entries even if previously stale', () => {
    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', ts(), { stale: true })],
    ]));

    statsCache.updateDocker(new Map([
      ['host1/c1', createMockDockerStat('host1/c1', ts())],
    ]));

    const result = statsCache.getDocker();
    expect(result[0].stale).toBe(false);
  });
});

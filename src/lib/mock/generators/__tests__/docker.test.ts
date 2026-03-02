import { describe, it, expect } from 'bun:test';
import { generateDockerSnapshot, generateDockerHistory, generateContainerHistory } from '../docker';
import { DOCKER_ENTITIES } from '../../entities';

describe('generateDockerSnapshot', () => {
  const time = new Date('2025-06-15T12:00:00Z');

  it('returns one row per entity', () => {
    const rows = generateDockerSnapshot(time);
    expect(rows).toHaveLength(DOCKER_ENTITIES.length);
  });

  it('is deterministic', () => {
    const rows1 = generateDockerSnapshot(time);
    const rows2 = generateDockerSnapshot(time);
    expect(rows1).toEqual(rows2);
  });

  it('produces valid DockerStatsRow shapes', () => {
    const rows = generateDockerSnapshot(time);
    for (const row of rows) {
      expect(row.time).toBe(time.toISOString());
      expect(typeof row.host).toBe('string');
      expect(typeof row.container_id).toBe('string');
      expect(typeof row.container_name).toBe('string');
      expect(typeof row.image).toBe('string');
      expect(typeof row.cpu_percent).toBe('number');
      expect(row.cpu_percent).toBeGreaterThanOrEqual(0);
      expect(typeof row.memory_usage).toBe('number');
      expect(row.memory_usage).toBeGreaterThanOrEqual(0);
      expect(typeof row.memory_limit).toBe('number');
      expect(row.memory_limit).toBeGreaterThan(0);
      expect(typeof row.memory_percent).toBe('number');
      expect(typeof row.network_rx_bytes_per_sec).toBe('number');
      expect(typeof row.network_tx_bytes_per_sec).toBe('number');
      expect(typeof row.block_io_read_bytes_per_sec).toBe('number');
      expect(typeof row.block_io_write_bytes_per_sec).toBe('number');
    }
  });

  it('includes all hosts from entity definitions', () => {
    const rows = generateDockerSnapshot(time);
    const hosts = new Set(rows.map((r) => r.host));
    const expectedHosts = new Set(DOCKER_ENTITIES.map((e) => e.host));
    expect(hosts).toEqual(expectedHosts);
  });
});

describe('generateDockerHistory', () => {
  it('returns correct number of rows', () => {
    const seconds = 5;
    const rows = generateDockerHistory(seconds);
    // (seconds + 1) snapshots * entities per snapshot
    expect(rows).toHaveLength((seconds + 1) * DOCKER_ENTITIES.length);
  });

  it('rows are ordered oldest-first', () => {
    const rows = generateDockerHistory(10);
    for (let i = 1; i < rows.length; i++) {
      const prevTime = new Date(rows[i - 1].time as string).getTime();
      const currTime = new Date(rows[i].time as string).getTime();
      expect(currTime).toBeGreaterThanOrEqual(prevTime);
    }
  });
});

describe('generateContainerHistory', () => {
  it('returns rows for an existing container', () => {
    const entity = DOCKER_ENTITIES[0];
    const now = Date.now();
    const rows = generateContainerHistory(
      entity.containerId,
      entity.host,
      now - 60000,
      now,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.container_id).toBe(entity.containerId);
      expect(row.host).toBe(entity.host);
    }
  });

  it('returns empty array for unknown container', () => {
    const rows = generateContainerHistory('nonexistent', undefined, 0, 60000);
    expect(rows).toEqual([]);
  });
});

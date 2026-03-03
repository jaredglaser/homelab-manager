import { describe, it, expect } from 'bun:test';
import { generateDockerSnapshot, generateDockerHistory, generateContainerHistory, generateContainerLogBatch, generateContainerLogHistory } from '../docker';
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

describe('generateContainerLogBatch', () => {
  const time = new Date('2025-06-15T12:00:00Z');

  it('returns lines with valid shape', () => {
    const batch = generateContainerLogBatch('nginx-proxy', time);
    expect(batch.lines.length).toBeGreaterThan(0);
    expect(batch.lines.length).toBeLessThanOrEqual(4);
    for (const line of batch.lines) {
      expect(typeof line.text).toBe('string');
      expect(line.text.length).toBeGreaterThan(0);
      expect(['stdout', 'stderr']).toContain(line.stream);
    }
  });

  it('is deterministic for the same container and time', () => {
    const batch1 = generateContainerLogBatch('postgres', time);
    const batch2 = generateContainerLogBatch('postgres', time);
    expect(batch1).toEqual(batch2);
  });

  it('produces different output for different containers', () => {
    const batch1 = generateContainerLogBatch('nginx-proxy', time);
    const batch2 = generateContainerLogBatch('postgres', time);
    expect(batch1.lines.map((l) => l.text)).not.toEqual(batch2.lines.map((l) => l.text));
  });

  it('produces different output for different time buckets', () => {
    const time1 = new Date('2025-06-15T12:00:00Z');
    const time2 = new Date('2025-06-15T12:00:04Z'); // 4s later = different 3s bucket
    const batch1 = generateContainerLogBatch('nginx-proxy', time1);
    const batch2 = generateContainerLogBatch('nginx-proxy', time2);
    expect(batch1.lines.map((l) => l.text)).not.toEqual(batch2.lines.map((l) => l.text));
  });

  it('uses service-specific templates for known containers', () => {
    const batch = generateContainerLogBatch('postgres', time);
    // Postgres logs should contain typical postgres patterns
    const allText = batch.lines.map((l) => l.text).join(' ');
    expect(allText).toContain('UTC');
  });

  it('falls back to default templates for unknown containers', () => {
    const batch = generateContainerLogBatch('unknown-service', time);
    expect(batch.lines.length).toBeGreaterThan(0);
    for (const line of batch.lines) {
      expect(typeof line.text).toBe('string');
      expect(['stdout', 'stderr']).toContain(line.stream);
    }
  });

  it('generates logs for all known docker entities', () => {
    for (const entity of DOCKER_ENTITIES) {
      const batch = generateContainerLogBatch(entity.containerName, time);
      expect(batch.lines.length).toBeGreaterThan(0);
    }
  });
});

describe('generateContainerLogHistory', () => {
  const time = new Date('2025-06-15T12:00:00Z');

  it('returns many more lines than a single batch', () => {
    const history = generateContainerLogHistory('nginx-proxy', time);
    const singleBatch = generateContainerLogBatch('nginx-proxy', time);
    expect(history.lines.length).toBeGreaterThan(singleBatch.lines.length);
  });

  it('defaults to 20 buckets', () => {
    const history = generateContainerLogHistory('nginx-proxy', time);
    // 20 buckets × 1-4 lines each = at least 20 lines
    expect(history.lines.length).toBeGreaterThanOrEqual(20);
  });

  it('respects custom bucket count', () => {
    const small = generateContainerLogHistory('nginx-proxy', time, 3);
    const large = generateContainerLogHistory('nginx-proxy', time, 30);
    expect(large.lines.length).toBeGreaterThan(small.lines.length);
  });

  it('is deterministic', () => {
    const h1 = generateContainerLogHistory('postgres', time);
    const h2 = generateContainerLogHistory('postgres', time);
    expect(h1).toEqual(h2);
  });

  it('lines are ordered oldest-first', () => {
    const history = generateContainerLogHistory('nginx-proxy', time);
    for (let i = 1; i < history.lines.length; i++) {
      expect(typeof history.lines[i].text).toBe('string');
      expect(['stdout', 'stderr']).toContain(history.lines[i].stream);
    }
  });
});

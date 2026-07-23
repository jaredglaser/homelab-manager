import { describe, it, expect } from 'bun:test';
import {
  generateDockerSnapshot,
  generateDockerInventorySnapshot,
  generateDockerHistory,
  generateContainerHistory,
  generateContainerLogBatch,
  generateContainerLogHistory,
} from '../docker';
import { DOCKER_ENTITIES } from '../../entities';

describe('generateDockerSnapshot', () => {
  const time = new Date('2025-06-15T12:00:00Z');

  it('returns one row per running demo entity', () => {
    const rows = generateDockerSnapshot(time);
    expect(rows).toHaveLength(7);
  });

  it('is deterministic', () => {
    const rows1 = generateDockerSnapshot(time);
    const rows2 = generateDockerSnapshot(time);
    expect(rows1).toEqual(rows2);
  });

  it('produces valid DockerStatsRow shapes', () => {
    const rows = generateDockerSnapshot(time);
    for (const row of rows) {
      expect(row.time).toBe(time.getTime());
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

  it('omits stats rows for non-running demo containers', () => {
    const rows = generateDockerSnapshot(time);
    const rowIds = new Set(rows.map((row) => `${row.host}/${row.container_id}`));
    const inventory = generateDockerInventorySnapshot(time);

    for (const container of inventory) {
      const entityId = `${container.host}/${container.containerId}`;
      expect(rowIds.has(entityId)).toBe(container.state === 'running');
    }
  });
});

describe('generateDockerInventorySnapshot', () => {
  const now = new Date('2025-06-15T12:00:00Z');

  it('returns one container per entity', () => {
    const containers = generateDockerInventorySnapshot(now);
    expect(containers).toHaveLength(DOCKER_ENTITIES.length);
  });

  it('matches each entity on host, containerId, name, image, serviceKey', () => {
    const containers = generateDockerInventorySnapshot(now);
    for (const c of containers) {
      const entity = DOCKER_ENTITIES.find(
        (e) => e.host === c.host && e.containerId === c.containerId,
      );
      expect(entity).toBeDefined();
      expect(c.name).toBe(entity!.containerName);
      expect(c.image).toBe(entity!.image);
      expect(c.serviceKey).toBe(entity!.serviceKey);
    }
  });

  it('includes demo containers across running, exited, restarting, and paused states', () => {
    const containers = generateDockerInventorySnapshot(now);
    const counts = containers.reduce<Record<string, number>>((acc, container) => {
      acc[container.state] = (acc[container.state] ?? 0) + 1;
      return acc;
    }, {});

    expect(counts.running).toBe(7);
    expect(counts.exited).toBe(1);
    expect(counts.restarting).toBe(1);
    expect(counts.paused).toBe(1);
  });

  it('sets exit metadata only on the exited demo container', () => {
    const containers = generateDockerInventorySnapshot(now);
    const exited = containers.filter((container) => container.state === 'exited');
    const nonExited = containers.filter((container) => container.state !== 'exited');

    expect(exited).toHaveLength(1);
    expect(exited[0]?.finishedAt).toBeInstanceOf(Date);
    expect(exited[0]?.exitCode).toBe(137);

    for (const container of nonExited) {
      expect(container.finishedAt).toBeNull();
      expect(container.exitCode).toBeNull();
    }
  });

  it('keeps one host in a mixed-state aggregate bucket layout for the demo', () => {
    const containers = generateDockerInventorySnapshot(now);
    const countsByHost = new Map<string, Record<string, number>>();

    for (const container of containers) {
      const hostCounts = countsByHost.get(container.host) ?? { running: 0, exited: 0, restarting: 0, paused: 0 };
      hostCounts[container.state] = (hostCounts[container.state] ?? 0) + 1;
      countsByHost.set(container.host, hostCounts);
    }

    expect(
      Array.from(countsByHost.values()).some(
        (counts) => counts.running > 0 && counts.exited > 0 && counts.restarting > 0 && counts.paused > 0,
      ),
    ).toBe(true);
  });

  it('keeps common inventory fields stable across all demo containers', () => {
    const containers = generateDockerInventorySnapshot(now);
    for (const c of containers) {
      expect(c.composeProject).toBeNull();
      expect(c.labels).toEqual({});
    }
  });

  it('uses Date objects for startedAt and updatedAt so JSON.stringify emits ISO strings', () => {
    const containers = generateDockerInventorySnapshot(now);
    for (const c of containers) {
      expect(c.startedAt).toBeInstanceOf(Date);
      expect(c.updatedAt).toBeInstanceOf(Date);
      expect(c.startedAt!.getTime()).toBeLessThan(now.getTime());
    }
  });

  it('gives every container an array for ports and mounts', () => {
    const containers = generateDockerInventorySnapshot(now);
    for (const c of containers) {
      expect(Array.isArray(c.ports)).toBe(true);
      expect(Array.isArray(c.mounts)).toBe(true);
    }
  });

  it('gives known demo containers plausible, non-empty ports and mounts', () => {
    const containers = generateDockerInventorySnapshot(now);
    const plex = containers.find((c) => c.name === 'plex')!;
    expect(plex.ports.length).toBeGreaterThan(0);
    expect(plex.mounts.length).toBeGreaterThan(0);
    expect(plex.ports[0]).toEqual({ containerPort: 32400, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 32400 });
  });

  it('parses successfully against the wire schema for every demo container', async () => {
    const { zDockerInventorySnapshotContainer } = await import('@/types/docker-inventory');
    const containers = generateDockerInventorySnapshot(now);
    for (const c of containers) {
      const result = zDockerInventorySnapshotContainer.safeParse(c);
      expect(result.success).toBe(true);
    }
  });
});

describe('generateDockerHistory', () => {
  it('returns correct number of rows', () => {
    const seconds = 5;
    const rows = generateDockerHistory(seconds);
    // (seconds + 1) snapshots * running demo entities per snapshot
    expect(rows).toHaveLength((seconds + 1) * 7);
  });

  it('rows are ordered oldest-first', () => {
    const rows = generateDockerHistory(10);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].time).toBeGreaterThanOrEqual(rows[i - 1].time);
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

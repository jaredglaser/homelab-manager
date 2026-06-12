import { describe, it, expect } from 'bun:test';
import {
  attachStatsToHierarchy,
  buildDockerInventoryHierarchy,
  buildDockerTableHierarchy,
  rowToDockerStats,
  computeServiceKey,
  totalContainers,
} from '../docker-hierarchy-builder';
import type { DockerStatsFromDB, DockerStatsRow } from '@/types/docker';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

describe('rowToDockerStats', () => {
  function createMockRow(overrides?: Partial<DockerStatsRow>): DockerStatsRow {
    return {
      time: '2024-01-01T00:00:00Z',
      host: 'host1',
      container_id: 'abc123def456',
      container_name: 'nginx',
      image: 'nginx:latest',
      cpu_percent: 25.5,
      memory_usage: 1073741824,
      memory_limit: 2147483648,
      memory_percent: 50,
      network_rx_bytes_per_sec: 1000,
      network_tx_bytes_per_sec: 500,
      block_io_read_bytes_per_sec: 2000,
      block_io_write_bytes_per_sec: 1000,
      ...overrides,
    };
  }

  it('should convert a DockerStatsRow to DockerStatsFromDB', () => {
    const row = createMockRow();
    const result = rowToDockerStats(row);

    expect(result.id).toBe('host1/abc123def456');
    expect(result.name).toBe('nginx');
    expect(result.image).toBe('nginx:latest');
    expect(result.icon).toBeNull();
    expect(result.stale).toBe(false);
    expect(result.rates.cpuPercent).toBe(25.5);
    expect(result.rates.memoryPercent).toBe(50);
    expect(result.memory_stats.usage).toBe(1073741824);
    expect(result.memory_stats.limit).toBe(2147483648);
  });

  it('should use container_id prefix when container_name is null', () => {
    const row = createMockRow({ container_name: null });
    const result = rowToDockerStats(row);

    expect(result.name).toBe('abc123def456'.substring(0, 12));
  });

  it('should use provided icon', () => {
    const row = createMockRow();
    const result = rowToDockerStats(row, 'nginx.svg');

    expect(result.icon).toBe('nginx.svg');
  });

  it('should set serviceKeyEntity to provided value', () => {
    const row = createMockRow();
    const result = rowToDockerStats(row, null, 'host1/media-stack/plex');

    expect(result.serviceKeyEntity).toBe('host1/media-stack/plex');
  });

  it('should fall back to host/container_name when serviceKeyEntity is not provided', () => {
    const row = createMockRow();
    const result = rowToDockerStats(row);

    // Falls back to host/name (not host/container_id) so recreated containers
    // with the same name naturally deduplicate before metadata is available
    expect(result.serviceKeyEntity).toBe('host1/nginx');
  });

  it('should fall back to host/short_id when container_name is null', () => {
    const row = createMockRow({ container_name: null });
    const result = rowToDockerStats(row);

    expect(result.serviceKeyEntity).toBe('host1/abc123def456');
  });

  it('should default null metrics to 0', () => {
    const row = createMockRow({
      cpu_percent: null,
      memory_percent: null,
      memory_usage: null,
      memory_limit: null,
      network_rx_bytes_per_sec: null,
      network_tx_bytes_per_sec: null,
      block_io_read_bytes_per_sec: null,
      block_io_write_bytes_per_sec: null,
    });
    const result = rowToDockerStats(row);

    expect(result.rates.cpuPercent).toBe(0);
    expect(result.rates.memoryPercent).toBe(0);
    expect(result.rates.networkRxBytesPerSec).toBe(0);
    expect(result.rates.networkTxBytesPerSec).toBe(0);
    expect(result.rates.blockIoReadBytesPerSec).toBe(0);
    expect(result.rates.blockIoWriteBytesPerSec).toBe(0);
    expect(result.memory_stats.usage).toBe(0);
    expect(result.memory_stats.limit).toBe(0);
  });

  it('should handle empty image string', () => {
    const row = createMockRow({ image: null });
    const result = rowToDockerStats(row);

    expect(result.image).toBe('');
  });
});

const baseDate = new Date('2024-01-01T00:00:00Z');

function makeInventory(
  host: string,
  containerId: string,
  name: string,
  overrides?: Partial<DockerInventorySnapshotContainer>,
): DockerInventorySnapshotContainer {
  return {
    host,
    containerId,
    name,
    image: 'nginx:latest',
    state: 'running',
    composeProject: null,
    serviceKey: name,
    startedAt: baseDate,
    finishedAt: null,
    exitCode: null,
    labels: {},
    updatedAt: baseDate,
    ...overrides,
  };
}

function makeStats(
  host: string,
  containerId: string,
  name: string,
  cpuPercent = 10,
): DockerStatsFromDB {
  return {
    id: `${host}/${containerId}`,
    serviceKeyEntity: `${host}/${name}`,
    name,
    image: 'nginx:latest',
    icon: null,
    stale: false,
    timestamp: baseDate,
    rates: {
      cpuPercent,
      memoryPercent: 50,
      networkRxBytesPerSec: 1000,
      networkTxBytesPerSec: 500,
      blockIoReadBytesPerSec: 2000,
      blockIoWriteBytesPerSec: 1000,
    },
    memory_stats: { usage: 512, limit: 1024 },
  };
}

describe('buildDockerTableHierarchy', () => {
  it('returns empty hosts for empty inventory', () => {
    const { hosts } = buildDockerTableHierarchy(new Map(), new Map());
    expect(hosts).toHaveLength(0);
  });

  it('produces container rows for all inventory entries regardless of stats', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'nginx', { state: 'running' })],
      ['host1/c2', makeInventory('host1', 'c2', 'redis', { state: 'exited' })],
      ['host1/c3', makeInventory('host1', 'c3', 'postgres', { state: 'paused' })],
    ]);
    const stats = new Map([
      ['host1/c1', makeStats('host1', 'c1', 'nginx')],
    ]);

    const { hosts } = buildDockerTableHierarchy(inventory, stats);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].children).toHaveLength(3);
  });

  it('marks running container with no stats as isStale=true', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'nginx', { state: 'running' })],
    ]);
    const { hosts } = buildDockerTableHierarchy(inventory, new Map());
    const container = hosts[0].children[0];
    expect(container.isStale).toBe(true);
    expect(container.stats).toBeUndefined();
  });

  it('marks stopped container with no stats as isStale=false', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'nginx', { state: 'exited' })],
    ]);
    const { hosts } = buildDockerTableHierarchy(inventory, new Map());
    const container = hosts[0].children[0];
    expect(container.isStale).toBe(false);
    expect(container.stats).toBeUndefined();
  });

  it('attaches stats to running container', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'nginx', { state: 'running' })],
    ]);
    const stats = new Map([['host1/c1', makeStats('host1', 'c1', 'nginx', 42)]]);
    const { hosts } = buildDockerTableHierarchy(inventory, stats);
    const container = hosts[0].children[0];
    expect(container.stats).toBeDefined();
    expect(container.stats!.rates.cpuPercent).toBe(42);
    expect(container.isStale).toBe(false);
  });

  it('computes correct state counts in host aggregates', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'r', { state: 'running' })],
      ['host1/c2', makeInventory('host1', 'c2', 'ex', { state: 'exited' })],
      ['host1/c3', makeInventory('host1', 'c3', 'dead', { state: 'dead' })],
      ['host1/c4', makeInventory('host1', 'c4', 'restart', { state: 'restarting' })],
      ['host1/c5', makeInventory('host1', 'c5', 'pause', { state: 'paused' })],
      ['host1/c6', makeInventory('host1', 'c6', 'created', { state: 'created' })],
    ]);
    const stats = new Map([['host1/c1', makeStats('host1', 'c1', 'r')]]);
    const { hosts } = buildDockerTableHierarchy(inventory, stats);
    const agg = hosts[0].aggregated;
    expect(totalContainers(agg)).toBe(6);
    expect(agg.runningCount).toBe(1);
    expect(agg.stoppedCount).toBe(2); // exited + dead
    expect(agg.restartingCount).toBe(1);
    expect(agg.pausedCount).toBe(1);
    expect(agg.otherCount).toBe(1); // created
  });

  it('computes metrics only from running containers with live stats', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'running', { state: 'running' })],
      ['host1/c2', makeInventory('host1', 'c2', 'stopped', { state: 'exited' })],
    ]);
    const stats = new Map([
      ['host1/c1', makeStats('host1', 'c1', 'running', 25)],
    ]);
    const { hosts } = buildDockerTableHierarchy(inventory, stats);
    // Only running container contributes to CPU
    expect(hosts[0].aggregated.cpuPercent).toBe(25);
  });

  it('sort order: running → restarting → paused → stopped → other', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'aaa', { state: 'created' })],
      ['host1/c2', makeInventory('host1', 'c2', 'bbb', { state: 'exited' })],
      ['host1/c3', makeInventory('host1', 'c3', 'ccc', { state: 'paused' })],
      ['host1/c4', makeInventory('host1', 'c4', 'ddd', { state: 'restarting' })],
      ['host1/c5', makeInventory('host1', 'c5', 'eee', { state: 'running' })],
    ]);
    const { hosts } = buildDockerTableHierarchy(inventory, new Map());
    const states = hosts[0].children.map((c) => c.inventory.state);
    expect(states).toEqual(['running', 'restarting', 'paused', 'exited', 'created']);
  });

  it('secondary sort by name within same state', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'zebra', { state: 'running' })],
      ['host1/c2', makeInventory('host1', 'c2', 'apple', { state: 'running' })],
      ['host1/c3', makeInventory('host1', 'c3', 'mango', { state: 'running' })],
    ]);
    const { hosts } = buildDockerTableHierarchy(inventory, new Map());
    const names = hosts[0].children.map((c) => c.inventory.name);
    expect(names).toEqual(['apple', 'mango', 'zebra']);
  });

  it('serviceKey dedup: keeps most recently started container', () => {
    const old = makeInventory('host1', 'c1', 'plex', {
      serviceKey: 'media/plex',
      startedAt: new Date('2024-01-01T00:00:00Z'),
    });
    const newer = makeInventory('host1', 'c2', 'plex', {
      serviceKey: 'media/plex',
      startedAt: new Date('2024-01-02T00:00:00Z'),
    });
    const inventory = new Map([
      ['host1/c1', old],
      ['host1/c2', newer],
    ]);
    const { hosts } = buildDockerTableHierarchy(inventory, new Map());
    // Only the newer one should be visible
    expect(hosts[0].children).toHaveLength(1);
    expect(hosts[0].children[0].id).toBe('host1/c2');
  });

  it('serviceKey dedup uses inv.serviceKey even when labels are empty (upsert event)', () => {
    const fromInit = makeInventory('host1', 'c1', 'plex', {
      serviceKey: 'media/plex',
      labels: { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'plex' },
      startedAt: new Date('2024-01-01T00:00:00Z'),
    });
    const fromUpsert = makeInventory('host1', 'c2', 'plex', {
      serviceKey: 'media/plex',
      labels: {},
      startedAt: new Date('2024-01-02T00:00:00Z'),
    });
    const inventory = new Map([
      ['host1/c1', fromInit],
      ['host1/c2', fromUpsert],
    ]);

    const { hosts } = buildDockerTableHierarchy(inventory, new Map());

    expect(hosts[0].children).toHaveLength(1);
    expect(hosts[0].children[0].id).toBe('host1/c2');
  });

  it('serviceKey dedup with mixed states: keeps most recently started', () => {
    const stopped = makeInventory('host1', 'c1', 'app', {
      state: 'exited',
      startedAt: new Date('2024-01-01T00:00:00Z'),
    });
    const running = makeInventory('host1', 'c2', 'app', {
      state: 'running',
      startedAt: new Date('2024-01-02T00:00:00Z'),
    });
    const inventory = new Map([
      ['host1/c1', stopped],
      ['host1/c2', running],
    ]);
    const { hosts } = buildDockerTableHierarchy(inventory, new Map());
    expect(hosts[0].children).toHaveLength(1);
    expect(hosts[0].children[0].inventory.state).toBe('running');
  });

  it('hosts are sorted alphabetically', () => {
    const inventory = new Map([
      ['zeta/c1', makeInventory('zeta', 'c1', 'nginx')],
      ['alpha/c2', makeInventory('alpha', 'c2', 'redis')],
    ]);
    const { hosts } = buildDockerTableHierarchy(inventory, new Map());
    expect(hosts.map((h) => h.hostName)).toEqual(['alpha', 'zeta']);
  });

  it('staleContainerCount counts running-without-stats containers', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'r1', { state: 'running' })],
      ['host1/c2', makeInventory('host1', 'c2', 'r2', { state: 'running' })],
      ['host1/c3', makeInventory('host1', 'c3', 'stopped', { state: 'exited' })],
    ]);
    // Only c2 has stats
    const stats = new Map([['host1/c2', makeStats('host1', 'c2', 'r2')]]);
    const { hosts } = buildDockerTableHierarchy(inventory, stats);
    expect(hosts[0].aggregated.staleContainerCount).toBe(1);
  });
});

describe('buildDockerInventoryHierarchy', () => {
  it('returns empty skeleton for empty inventory', () => {
    const result = buildDockerInventoryHierarchy(new Map());
    expect(result.hostNames).toHaveLength(0);
    expect(result.containersByHost.size).toBe(0);
  });

  it('groups deduped containers per host with hosts sorted alphabetically', () => {
    const inventory = new Map([
      ['zeta/c1', makeInventory('zeta', 'c1', 'nginx')],
      ['alpha/c2', makeInventory('alpha', 'c2', 'redis')],
      ['alpha/c3', makeInventory('alpha', 'c3', 'postgres')],
    ]);
    const result = buildDockerInventoryHierarchy(inventory);
    expect(result.hostNames).toEqual(['alpha', 'zeta']);
    expect(result.containersByHost.get('alpha')).toHaveLength(2);
    expect(result.containersByHost.get('zeta')).toHaveLength(1);
  });

  it('sorts containers by state priority then name', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'zebra', { state: 'exited' })],
      ['host1/c2', makeInventory('host1', 'c2', 'zebra-live', { state: 'running' })],
      ['host1/c3', makeInventory('host1', 'c3', 'apple-live', { state: 'running' })],
    ]);
    const result = buildDockerInventoryHierarchy(inventory);
    const names = result.containersByHost.get('host1')!.map((inv) => inv.name);
    expect(names).toEqual(['apple-live', 'zebra-live', 'zebra']);
  });

  it('dedupes by serviceKey keeping the most recently started container', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'plex', {
        serviceKey: 'media/plex',
        startedAt: new Date('2024-01-01T00:00:00Z'),
      })],
      ['host1/c2', makeInventory('host1', 'c2', 'plex', {
        serviceKey: 'media/plex',
        startedAt: new Date('2024-01-02T00:00:00Z'),
      })],
    ]);
    const result = buildDockerInventoryHierarchy(inventory);
    const containers = result.containersByHost.get('host1')!;
    expect(containers).toHaveLength(1);
    expect(containers[0].containerId).toBe('c2');
  });
});

describe('attachStatsToHierarchy', () => {
  it('reusing the same skeleton with different stats yields updated rows', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'nginx', { state: 'running' })],
    ]);
    const skeleton = buildDockerInventoryHierarchy(inventory);

    const first = attachStatsToHierarchy(skeleton, new Map());
    expect(first.hosts[0].children[0].isStale).toBe(true);
    expect(first.hosts[0].children[0].stats).toBeUndefined();

    const stats = new Map([['host1/c1', makeStats('host1', 'c1', 'nginx', 33)]]);
    const second = attachStatsToHierarchy(skeleton, stats);
    expect(second.hosts[0].children[0].isStale).toBe(false);
    expect(second.hosts[0].children[0].stats!.rates.cpuPercent).toBe(33);
  });

  it('sets totalHosts and host row ids from the skeleton', () => {
    const inventory = new Map([
      ['host1/c1', makeInventory('host1', 'c1', 'nginx')],
      ['host2/c2', makeInventory('host2', 'c2', 'redis')],
    ]);
    const { hosts } = attachStatsToHierarchy(buildDockerInventoryHierarchy(inventory), new Map());
    expect(hosts).toHaveLength(2);
    expect(hosts[0].id).toBe('host:host1');
    expect(hosts[0].totalHosts).toBe(2);
    expect(hosts[1].id).toBe('host:host2');
  });
});

describe('computeServiceKey', () => {
  it('should return project/service when both compose labels are present', () => {
    const labels = {
      'com.docker.compose.project': 'media-stack',
      'com.docker.compose.service': 'plex',
    };
    expect(computeServiceKey(labels, 'plex')).toBe('media-stack/plex');
  });

  it('should return container name when labels is undefined', () => {
    expect(computeServiceKey(undefined, 'my-app')).toBe('my-app');
  });

  it('should return container name when labels is an empty object', () => {
    expect(computeServiceKey({}, 'my-app')).toBe('my-app');
  });

  it('should return container name when only compose project label is present', () => {
    const labels = { 'com.docker.compose.project': 'my-project' };
    expect(computeServiceKey(labels, 'my-app')).toBe('my-app');
  });

  it('should return container name when only compose service label is present', () => {
    const labels = { 'com.docker.compose.service': 'my-service' };
    expect(computeServiceKey(labels, 'my-app')).toBe('my-app');
  });

  it('should sanitize slashes in project and service labels', () => {
    const labels = {
      'com.docker.compose.project': 'my/project',
      'com.docker.compose.service': 'my/service',
    };
    expect(computeServiceKey(labels, 'my-app')).toBe('my-project/my-service');
  });

  it('should include project in key to distinguish same service names across projects', () => {
    const labels1 = { 'com.docker.compose.project': 'project-a', 'com.docker.compose.service': 'db' };
    const labels2 = { 'com.docker.compose.project': 'project-b', 'com.docker.compose.service': 'db' };
    expect(computeServiceKey(labels1, 'db')).toBe('project-a/db');
    expect(computeServiceKey(labels2, 'db')).toBe('project-b/db');
    expect(computeServiceKey(labels1, 'db')).not.toBe(computeServiceKey(labels2, 'db'));
  });
});

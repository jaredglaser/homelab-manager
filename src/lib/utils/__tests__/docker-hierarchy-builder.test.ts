import { describe, it, expect } from 'bun:test';
import { buildDockerHierarchy, buildDockerTableHierarchy, rowToDockerStats, computeServiceKey } from '../docker-hierarchy-builder';
import type { DockerStatsFromDB, DockerStatsRow } from '@/types/docker';
import type { DockerContainerInventory } from '@/types/docker-inventory';

describe('buildDockerHierarchy', () => {
  // Helper to create mock Docker stats
  function createMockStats(
    hostName: string,
    containerId: string,
    containerName: string,
    overrides?: Partial<DockerStatsFromDB['rates'] & DockerStatsFromDB['memory_stats'] & { stale: boolean }>
  ): DockerStatsFromDB {
    return {
      id: `${hostName}/${containerId}`,
      serviceKeyEntity: `${hostName}/${containerName}`,
      name: containerName,
      image: 'nginx:latest',
      icon: null,
      stale: overrides?.stale ?? false,
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

  describe('stable sorting', () => {
    it('should sort hosts alphabetically regardless of input order', () => {
      const stats = [
        createMockStats('zeta-host', 'c1', 'nginx'),
        createMockStats('alpha-host', 'c2', 'redis'),
        createMockStats('mid-host', 'c3', 'postgres'),
      ];

      const hierarchy = buildDockerHierarchy(stats);
      const hostNames = [...hierarchy.keys()];

      expect(hostNames).toEqual(['alpha-host', 'mid-host', 'zeta-host']);
    });

    it('should sort containers within a host alphabetically by name', () => {
      const stats = [
        createMockStats('host1', 'c3', 'redis'),
        createMockStats('host1', 'c1', 'nginx'),
        createMockStats('host1', 'c2', 'caddy'),
      ];

      const hierarchy = buildDockerHierarchy(stats);
      const containerNames = [...hierarchy.get('host1')!.containers.values()]
        .map(c => c.data.name);

      expect(containerNames).toEqual(['caddy', 'nginx', 'redis']);
    });

    it('should produce identical ordering for different input orders', () => {
      const mkStats = (order: string[]) =>
        order.map(name => createMockStats('host1', name, name));

      const hierarchy1 = buildDockerHierarchy(mkStats(['zebra', 'apple', 'mango']));
      const hierarchy2 = buildDockerHierarchy(mkStats(['mango', 'zebra', 'apple']));
      const hierarchy3 = buildDockerHierarchy(mkStats(['apple', 'mango', 'zebra']));

      const getNames = (h: ReturnType<typeof buildDockerHierarchy>) =>
        [...h.get('host1')!.containers.values()].map(c => c.data.name);

      expect(getNames(hierarchy1)).toEqual(['apple', 'mango', 'zebra']);
      expect(getNames(hierarchy2)).toEqual(['apple', 'mango', 'zebra']);
      expect(getNames(hierarchy3)).toEqual(['apple', 'mango', 'zebra']);
    });
  });

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

  it('should throw error for invalid entity path format', () => {
    const stats: DockerStatsFromDB[] = [
      {
        id: 'invalid-no-slash', // Missing slash
        serviceKeyEntity: 'invalid-no-slash',
        name: 'test',
        image: 'test:latest',
        icon: null,
        stale: false,
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

  describe('stale container handling', () => {
    it('should exclude stale containers from aggregation sums', () => {
      const stats = [
        createMockStats('host1', 'c1', 'nginx', { cpuPercent: 25 }),
        createMockStats('host1', 'c2', 'redis', { cpuPercent: 15, stale: true }),
      ];

      const hierarchy = buildDockerHierarchy(stats);
      const host = hierarchy.get('host1')!;

      // Only fresh container (nginx, 25%) should be in the sum
      expect(host.aggregated.cpuPercent).toBe(25);
    });

    it('should count stale containers separately', () => {
      const stats = [
        createMockStats('host1', 'c1', 'nginx'),
        createMockStats('host1', 'c2', 'redis', { stale: true }),
        createMockStats('host1', 'c3', 'postgres', { stale: true }),
      ];

      const hierarchy = buildDockerHierarchy(stats);
      const host = hierarchy.get('host1')!;

      expect(host.aggregated.containerCount).toBe(3);
      expect(host.aggregated.staleContainerCount).toBe(2);
    });

    it('should set isStale true when all containers are stale', () => {
      const stats = [
        createMockStats('host1', 'c1', 'nginx', { stale: true }),
        createMockStats('host1', 'c2', 'redis', { stale: true }),
      ];

      const hierarchy = buildDockerHierarchy(stats);
      expect(hierarchy.get('host1')!.isStale).toBe(true);
    });

    it('should set isStale false when some containers are fresh', () => {
      const stats = [
        createMockStats('host1', 'c1', 'nginx'),
        createMockStats('host1', 'c2', 'redis', { stale: true }),
      ];

      const hierarchy = buildDockerHierarchy(stats);
      expect(hierarchy.get('host1')!.isStale).toBe(false);
    });

    it('should set isStale false when no containers are stale', () => {
      const stats = [
        createMockStats('host1', 'c1', 'nginx'),
        createMockStats('host1', 'c2', 'redis'),
      ];

      const hierarchy = buildDockerHierarchy(stats);
      expect(hierarchy.get('host1')!.isStale).toBe(false);
      expect(hierarchy.get('host1')!.aggregated.staleContainerCount).toBe(0);
    });

    it('should exclude stale container memory from host aggregation', () => {
      const stats = [
        createMockStats('host1', 'c1', 'nginx', { usage: 1000, limit: 2000 }),
        createMockStats('host1', 'c2', 'redis', { usage: 500, limit: 1000, stale: true }),
      ];

      const hierarchy = buildDockerHierarchy(stats);
      const host = hierarchy.get('host1')!;

      // Only fresh container should contribute
      expect(host.aggregated.memoryUsage).toBe(1000);
      expect(host.aggregated.memoryLimit).toBe(2000);
    });
  });
});

describe('buildDockerTableHierarchy', () => {
  const baseDate = new Date('2024-01-01T00:00:00Z');

  function makeInventory(
    host: string,
    containerId: string,
    name: string,
    overrides?: Partial<DockerContainerInventory>,
  ): DockerContainerInventory {
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
    expect(agg.containerCount).toBe(6);
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
      labels: { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'plex' },
      startedAt: new Date('2024-01-01T00:00:00Z'),
    });
    const newer = makeInventory('host1', 'c2', 'plex', {
      labels: { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'plex' },
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

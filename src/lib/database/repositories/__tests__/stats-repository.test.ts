import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { StatsRepository } from '../stats-repository';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function createMockPool() {
  const queries: QueryCall[] = [];
  const resultQueue: { rows: unknown[] }[] = [];
  let defaultResult: { rows: unknown[] } = { rows: [] };
  let shouldThrow: Error | null = null;

  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        if (shouldThrow) throw shouldThrow;
        queries.push({ sql, params: params ?? [] });
        return resultQueue.length > 0 ? resultQueue.shift()! : defaultResult;
      },
    } as any,
    queries,
    pushResult(rows: unknown[]) {
      resultQueue.push({ rows });
    },
    setDefault(rows: unknown[]) {
      defaultResult = { rows };
    },
    setError(err: Error) {
      shouldThrow = err;
    },
    clearError() {
      shouldThrow = null;
    },
  };
}

describe('StatsRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;
  let repo: StatsRepository;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockPool = createMockPool();
    repo = new StatsRepository(mockPool.pool);
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('insertDockerStats', () => {
    it('should skip insert for empty rows', async () => {
      await repo.insertDockerStats([]);
      expect(mockPool.queries).toHaveLength(0);
    });

    it('should insert rows with correct parameters', async () => {
      const rows = [
        {
          time: new Date('2024-01-01'),
          host: 'host1',
          container_id: 'abc123',
          container_name: 'nginx',
          image: 'nginx:latest',
          cpu_percent: 25.5,
          memory_usage: 1024,
          memory_limit: 2048,
          memory_percent: 50,
          network_rx_bytes_per_sec: 100,
          network_tx_bytes_per_sec: 200,
          block_io_read_bytes_per_sec: 300,
          block_io_write_bytes_per_sec: 400,
        },
      ];

      await repo.insertDockerStats(rows);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('INSERT INTO docker_stats');
      expect(mockPool.queries[0].params[0]).toEqual([new Date('2024-01-01')]);
      expect(mockPool.queries[0].params[1]).toEqual(['host1']);
      expect(mockPool.queries[0].params[2]).toEqual(['abc123']);
    });

    it('should handle multiple rows', async () => {
      const rows = [
        {
          time: new Date('2024-01-01'),
          host: 'host1',
          container_id: 'abc',
          container_name: 'nginx',
          image: 'nginx:latest',
          cpu_percent: 10,
          memory_usage: 100,
          memory_limit: 200,
          memory_percent: 50,
          network_rx_bytes_per_sec: 0,
          network_tx_bytes_per_sec: 0,
          block_io_read_bytes_per_sec: 0,
          block_io_write_bytes_per_sec: 0,
        },
        {
          time: new Date('2024-01-01'),
          host: 'host1',
          container_id: 'def',
          container_name: 'redis',
          image: 'redis:latest',
          cpu_percent: 5,
          memory_usage: 50,
          memory_limit: 100,
          memory_percent: 50,
          network_rx_bytes_per_sec: 0,
          network_tx_bytes_per_sec: 0,
          block_io_read_bytes_per_sec: 0,
          block_io_write_bytes_per_sec: 0,
        },
      ];

      await repo.insertDockerStats(rows);

      expect(mockPool.queries[0].params[1]).toEqual(['host1', 'host1']);
      expect(mockPool.queries[0].params[2]).toEqual(['abc', 'def']);
    });

    it('should propagate errors', async () => {
      mockPool.setError(new Error('DB error'));

      await expect(repo.insertDockerStats([{
        time: new Date(),
        host: 'h',
        container_id: 'c',
        container_name: null,
        image: null,
        cpu_percent: null,
        memory_usage: null,
        memory_limit: null,
        memory_percent: null,
        network_rx_bytes_per_sec: null,
        network_tx_bytes_per_sec: null,
        block_io_read_bytes_per_sec: null,
        block_io_write_bytes_per_sec: null,
      }])).rejects.toThrow('DB error');
    });
  });

  describe('insertZFSStats', () => {
    it('should skip insert for empty rows', async () => {
      await repo.insertZFSStats([]);
      expect(mockPool.queries).toHaveLength(0);
    });

    it('should insert rows with correct parameters', async () => {
      const rows = [
        {
          time: new Date('2024-01-01'),
          host: 'server1',
          pool: 'tank',
          entity: 'tank',
          entity_type: 'pool',
          indent: 0,
          capacity_alloc: 1000,
          capacity_free: 2000,
          read_ops_per_sec: 10,
          write_ops_per_sec: 5,
          read_bytes_per_sec: 1024,
          write_bytes_per_sec: 512,
          utilization_percent: 33.3,
        },
      ];

      await repo.insertZFSStats(rows);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('INSERT INTO zfs_stats');
    });

    it('should propagate errors', async () => {
      mockPool.setError(new Error('ZFS DB error'));

      await expect(repo.insertZFSStats([{
        time: new Date(),
        host: 'server1',
        pool: 'tank',
        entity: 'tank',
        entity_type: 'pool',
        indent: 0,
        capacity_alloc: null,
        capacity_free: null,
        read_ops_per_sec: null,
        write_ops_per_sec: null,
        read_bytes_per_sec: null,
        write_bytes_per_sec: null,
        utilization_percent: null,
      }])).rejects.toThrow('ZFS DB error');
    });
  });

  describe('getDockerStatsSince', () => {
    it('should query with Date parameter', async () => {
      const since = new Date('2024-01-01T00:00:00Z');
      await repo.getDockerStatsSince(since);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('docker_stats');
      expect(mockPool.queries[0].sql).toContain('time > $1');
      expect(mockPool.queries[0].params).toEqual([since]);
    });

    it('should return rows from query result', async () => {
      const mockRows = [{
        time: new Date(), host: 'h1', container_id: 'c1',
        container_name: 'nginx', image: 'nginx:latest',
        cpu_percent: 10, memory_usage: 100, memory_limit: 200,
        memory_percent: 50, network_rx_bytes_per_sec: 0,
        network_tx_bytes_per_sec: 0, block_io_read_bytes_per_sec: 0,
        block_io_write_bytes_per_sec: 0,
      }];
      mockPool.pushResult(mockRows);

      const result = await repo.getDockerStatsSince(new Date());
      expect(result).toEqual(mockRows);
    });
  });

  describe('getZFSStatsSince', () => {
    it('should query with Date parameter', async () => {
      const since = new Date('2024-01-01T00:00:00Z');
      await repo.getZFSStatsSince(since);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('zfs_stats');
      expect(mockPool.queries[0].sql).toContain('time > $1');
      expect(mockPool.queries[0].params).toEqual([since]);
    });
  });

  describe('getDockerStatsHistory', () => {
    it('should use 1s bucket for short windows (≤ 300s)', async () => {
      await repo.getDockerStatsHistory(60);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('docker_stats');
      expect(mockPool.queries[0].sql).toContain('time_bucket');
      expect(mockPool.queries[0].params).toEqual([60, 1]);
    });

    it('should jump to 2s bucket at the 301s boundary', async () => {
      await repo.getDockerStatsHistory(301);

      // bucketSeconds = Math.max(1, Math.ceil(301 / 300)) = 2
      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('time_bucket');
      expect(mockPool.queries[0].sql).toContain('docker_stats');
      expect(mockPool.queries[0].params).toEqual([301, 2]);
    });

    it('should use larger bucket for long windows to cap at ~300 data points', async () => {
      await repo.getDockerStatsHistory(1800);

      // bucketSeconds = Math.max(1, Math.ceil(1800 / 300)) = 6
      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('time_bucket');
      expect(mockPool.queries[0].params).toEqual([1800, 6]);
    });
  });

  describe('getZFSStatsHistory', () => {
    it('should query with seconds parameter', async () => {
      await repo.getZFSStatsHistory(120);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('zfs_stats');
      expect(mockPool.queries[0].sql).toContain('make_interval');
      expect(mockPool.queries[0].params).toEqual([120]);
    });
  });

  describe('upsertEntityMetadata', () => {
    it('should upsert with correct parameters', async () => {
      await repo.upsertEntityMetadata('docker', 'host1/container1', 'icon', 'nginx.svg');

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('entity_metadata');
      expect(mockPool.queries[0].sql).toContain('ON CONFLICT');
      expect(mockPool.queries[0].params).toEqual(['docker', 'host1/container1', 'icon', 'nginx.svg']);
    });
  });

  describe('getEntityMetadata', () => {
    it('should return empty map for empty entities', async () => {
      const result = await repo.getEntityMetadata('docker', []);
      expect(result.size).toBe(0);
      expect(mockPool.queries).toHaveLength(0);
    });

    it('should query and build metadata map', async () => {
      mockPool.pushResult([
        { entity: 'host1/c1', key: 'icon', value: 'nginx.svg' },
        { entity: 'host1/c1', key: 'label', value: 'Web Server' },
        { entity: 'host1/c2', key: 'icon', value: 'redis.svg' },
      ]);

      const result = await repo.getEntityMetadata('docker', ['host1/c1', 'host1/c2']);

      expect(result.size).toBe(2);
      expect(result.get('host1/c1')!.get('icon')).toBe('nginx.svg');
      expect(result.get('host1/c1')!.get('label')).toBe('Web Server');
      expect(result.get('host1/c2')!.get('icon')).toBe('redis.svg');
    });
  });

  describe('getDockerStatsForContainer', () => {
    it('should query with correct time range and container filter', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T00:05:00Z');

      await repo.getDockerStatsForContainer('abc123', undefined, from, to);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('docker_stats');
      expect(mockPool.queries[0].sql).toContain('time_bucket');
      expect(mockPool.queries[0].sql).toContain('container_id = $4');
      expect(mockPool.queries[0].params).toEqual([from, to, 1, 'abc123']);
    });

    it('should append host filter when host is provided', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T00:05:00Z');

      await repo.getDockerStatsForContainer('abc123', 'server1', from, to);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('host = $5');
      expect(mockPool.queries[0].params).toEqual([from, to, 1, 'abc123', 'server1']);
    });

    it('should not include host filter when host is undefined', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T00:05:00Z');

      await repo.getDockerStatsForContainer('abc123', undefined, from, to);

      expect(mockPool.queries[0].sql).not.toContain('host = $5');
      expect(mockPool.queries[0].params).toEqual([from, to, 1, 'abc123']);
    });

    it('should use 1s bucket for short windows (≤ 300s with default targetPoints)', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T00:05:00Z'); // 300s

      await repo.getDockerStatsForContainer('abc123', undefined, from, to);

      // 300s / 300 targetPoints = 1s bucket
      expect(mockPool.queries[0].params[2]).toBe(1);
    });

    it('should compute larger buckets for longer time ranges', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T01:00:00Z'); // 3600s

      await repo.getDockerStatsForContainer('abc123', undefined, from, to);

      // 3600s / 300 targetPoints = 12s bucket
      expect(mockPool.queries[0].params[2]).toBe(12);
    });

    it('should respect custom targetPoints', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T00:10:00Z'); // 600s

      await repo.getDockerStatsForContainer('abc123', undefined, from, to, 100);

      // 600s / 100 targetPoints = 6s bucket
      expect(mockPool.queries[0].params[2]).toBe(6);
    });

    it('should return rows from query result', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T00:05:00Z');
      const mockRows = [{
        time: new Date(), host: 'h1', container_id: 'abc123',
        container_name: 'nginx', image: 'nginx:latest',
        cpu_percent: 10, memory_usage: 100, memory_limit: 200,
        memory_percent: 50, network_rx_bytes_per_sec: 0,
        network_tx_bytes_per_sec: 0, block_io_read_bytes_per_sec: 0,
        block_io_write_bytes_per_sec: 0,
      }];
      mockPool.pushResult(mockRows);

      const result = await repo.getDockerStatsForContainer('abc123', undefined, from, to);
      expect(result).toEqual(mockRows);
    });
  });

  describe('getContainerInfo', () => {
    it('should query with container_id filter', async () => {
      await repo.getContainerInfo('abc123');

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('container_id = $1');
      expect(mockPool.queries[0].sql).toContain('ORDER BY time DESC');
      expect(mockPool.queries[0].sql).toContain('LIMIT 1');
      expect(mockPool.queries[0].params).toEqual(['abc123']);
    });

    it('should append host filter when host is provided', async () => {
      await repo.getContainerInfo('abc123', 'server1');

      expect(mockPool.queries[0].sql).toContain('host = $2');
      expect(mockPool.queries[0].params).toEqual(['abc123', 'server1']);
    });

    it('should not include host filter when host is undefined', async () => {
      await repo.getContainerInfo('abc123');

      expect(mockPool.queries[0].sql).not.toContain('host = $2');
      expect(mockPool.queries[0].params).toEqual(['abc123']);
    });

    it('should return container info when found', async () => {
      const info = { container_name: 'nginx', image: 'nginx:latest', host: 'server1' };
      mockPool.pushResult([info]);

      const result = await repo.getContainerInfo('abc123');
      expect(result).toEqual(info);
    });

    it('should return null when no rows found', async () => {
      mockPool.pushResult([]);

      const result = await repo.getContainerInfo('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getSourceIcons', () => {
    it('should query with source and icon key filter', async () => {
      await repo.getSourceIcons('docker');

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('entity_metadata');
      expect(mockPool.queries[0].sql).toContain("key = 'icon'");
      expect(mockPool.queries[0].params).toEqual(['docker']);
    });

    it('should return a map of entity to icon value', async () => {
      mockPool.pushResult([
        { entity: 'host1/nginx', value: 'nginx.svg' },
        { entity: 'host1/redis', value: 'redis.svg' },
      ]);

      const result = await repo.getSourceIcons('docker');

      expect(result.size).toBe(2);
      expect(result.get('host1/nginx')).toBe('nginx.svg');
      expect(result.get('host1/redis')).toBe('redis.svg');
    });

    it('should return empty map when no icons exist', async () => {
      mockPool.pushResult([]);

      const result = await repo.getSourceIcons('docker');
      expect(result.size).toBe(0);
    });
  });
});

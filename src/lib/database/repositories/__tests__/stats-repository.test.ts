import { describe, it, expect, beforeEach } from 'bun:test';
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

// Suppress console.error during error tests
const originalConsoleError = console.error;

describe('StatsRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;
  let repo: StatsRepository;

  beforeEach(() => {
    mockPool = createMockPool();
    repo = new StatsRepository(mockPool.pool);
  });

  describe('insertDockerStats', () => {
    it('should skip insert for empty rows', async () => {
      await repo.insertDockerStats([]);
      expect(mockPool.queries).toHaveLength(0);
    });

    it('should insert rows and send NOTIFY', async () => {
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

      expect(mockPool.queries).toHaveLength(2);

      // First call: INSERT
      expect(mockPool.queries[0].sql).toContain('INSERT INTO docker_stats');
      expect(mockPool.queries[0].params[0]).toEqual([new Date('2024-01-01')]);
      expect(mockPool.queries[0].params[1]).toEqual(['host1']);
      expect(mockPool.queries[0].params[2]).toEqual(['abc123']);

      // Second call: NOTIFY
      expect(mockPool.queries[1].sql).toContain("pg_notify('stats_update', 'docker')");
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
      console.error = () => {};
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

      console.error = originalConsoleError;
    });
  });

  describe('insertZFSStats', () => {
    it('should skip insert for empty rows', async () => {
      await repo.insertZFSStats([]);
      expect(mockPool.queries).toHaveLength(0);
    });

    it('should insert rows and send NOTIFY', async () => {
      const rows = [
        {
          time: new Date('2024-01-01'),
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

      expect(mockPool.queries).toHaveLength(2);
      expect(mockPool.queries[0].sql).toContain('INSERT INTO zfs_stats');
      expect(mockPool.queries[1].sql).toContain("pg_notify('stats_update', 'zfs')");
    });

    it('should propagate errors', async () => {
      console.error = () => {};
      mockPool.setError(new Error('ZFS DB error'));

      await expect(repo.insertZFSStats([{
        time: new Date(),
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

      console.error = originalConsoleError;
    });
  });

  describe('getDockerStatsSince', () => {
    it('should query with correct parameters', async () => {
      const since = new Date('2024-01-01');
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
    it('should query with correct parameters', async () => {
      const since = new Date('2024-01-01');
      await repo.getZFSStatsSince(since);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('zfs_stats');
      expect(mockPool.queries[0].sql).toContain('time > $1');
      expect(mockPool.queries[0].params).toEqual([since]);
    });
  });

  describe('getDockerStatsHistory', () => {
    it('should query with seconds parameter', async () => {
      await repo.getDockerStatsHistory(60);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('docker_stats');
      expect(mockPool.queries[0].sql).toContain('make_interval');
      expect(mockPool.queries[0].params).toEqual([60]);
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
});

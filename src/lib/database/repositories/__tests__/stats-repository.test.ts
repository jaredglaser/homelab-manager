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
    it('should use 1s bucket for short windows (≤ 300s)', async () => {
      await repo.getZFSStatsHistory(120);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('zfs_stats');
      expect(mockPool.queries[0].sql).toContain('time_bucket');
      expect(mockPool.queries[0].params).toEqual([120, 1]);
    });

    it('should use larger bucket for long windows to cap at ~300 data points', async () => {
      await repo.getZFSStatsHistory(1800);

      // bucketSeconds = Math.max(1, Math.ceil(1800 / 300)) = 6
      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('time_bucket');
      expect(mockPool.queries[0].params).toEqual([1800, 6]);
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
    // Each call issues two queries: a bounds query (actual data extent) + the bucketed data query.
    // The bounds query (queries[0]) returns actual_span_secs; the data query (queries[1]) returns rows.
    // When bounds returns no rows, bucket falls back to requested range.
    // Accepts an array of container IDs and queries with ANY($N) to unify history across recreations.

    it('should query with correct time range and container filter', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T00:05:00Z');

      await repo.getDockerStatsForContainer(['abc123'], undefined, from, to);

      expect(mockPool.queries).toHaveLength(2);
      // Bounds query uses ANY for container IDs
      expect(mockPool.queries[0].sql).toContain('actual_span_secs');
      expect(mockPool.queries[0].sql).toContain('container_id = ANY($3)');
      expect(mockPool.queries[0].params).toEqual([from, to, ['abc123']]);
      // Data query
      expect(mockPool.queries[1].sql).toContain('docker_stats');
      expect(mockPool.queries[1].sql).toContain('time_bucket');
      expect(mockPool.queries[1].sql).toContain('container_id = ANY($4)');
      expect(mockPool.queries[1].params).toEqual([from, to, 1, ['abc123']]);
    });

    it('should accept multiple container IDs for service group queries', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T00:05:00Z');

      await repo.getDockerStatsForContainer(['abc123', 'def456', 'ghi789'], undefined, from, to);

      expect(mockPool.queries[0].params).toEqual([from, to, ['abc123', 'def456', 'ghi789']]);
      expect(mockPool.queries[1].params).toEqual([from, to, 1, ['abc123', 'def456', 'ghi789']]);
    });

    it('should group by time bucket without container_id (unified series)', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T00:05:00Z');

      await repo.getDockerStatsForContainer(['abc123'], undefined, from, to);

      const sql = mockPool.queries[1].sql;
      // Groups by time + host only - no container_id in GROUP BY
      expect(sql).toContain('GROUP BY time_bucket');
      expect(sql).not.toContain('GROUP BY time_bucket(make_interval(secs => $3), time), host, container_id');
      // Uses last() to preserve a representative container_id in the output
      expect(sql).toContain('last(container_id, time)');
    });

    it('should append host filter when host is provided', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T00:05:00Z');

      await repo.getDockerStatsForContainer(['abc123'], 'server1', from, to);

      expect(mockPool.queries).toHaveLength(2);
      // Bounds query includes host filter
      expect(mockPool.queries[0].sql).toContain('host = $4');
      expect(mockPool.queries[0].params).toEqual([from, to, ['abc123'], 'server1']);
      // Data query includes host filter
      expect(mockPool.queries[1].sql).toContain('host = $5');
      expect(mockPool.queries[1].params).toEqual([from, to, 1, ['abc123'], 'server1']);
    });

    it('should not include host filter when host is undefined', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T00:05:00Z');

      await repo.getDockerStatsForContainer(['abc123'], undefined, from, to);

      expect(mockPool.queries[1].sql).not.toContain('host = $5');
      expect(mockPool.queries[1].params).toEqual([from, to, 1, ['abc123']]);
    });

    it('should use 1s bucket for short windows (≤ 300s with default targetPoints)', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T00:05:00Z'); // 300s

      await repo.getDockerStatsForContainer(['abc123'], undefined, from, to);

      // Bounds returns empty → falls back to requested 300s / 300 targetPoints = 1s bucket
      expect(mockPool.queries[1].params[2]).toBe(1);
    });

    it('should compute larger buckets for longer time ranges', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T01:00:00Z'); // 3600s

      await repo.getDockerStatsForContainer(['abc123'], undefined, from, to);

      // Bounds returns empty → falls back to requested 3600s / 300 targetPoints = 12s bucket
      expect(mockPool.queries[1].params[2]).toBe(12);
    });

    it('should respect custom targetPoints', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-01T00:10:00Z'); // 600s

      await repo.getDockerStatsForContainer(['abc123'], undefined, from, to, 100);

      // Bounds returns empty → falls back to requested 600s / 100 targetPoints = 6s bucket
      expect(mockPool.queries[1].params[2]).toBe(6);
    });

    it('should bucket based on actual data extent when shorter than requested range', async () => {
      const from = new Date('2024-01-01T00:00:00Z');
      const to = new Date('2024-01-02T00:00:00Z'); // 86400s requested

      // Bounds query returns actual data spanning only 600 seconds
      mockPool.pushResult([{ actual_span_secs: 600 }]);

      await repo.getDockerStatsForContainer(['abc123'], undefined, from, to);

      // 600s actual / 300 targetPoints = 2s bucket (not 86400/300 = 288s)
      expect(mockPool.queries[1].params[2]).toBe(2);
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
      // Push bounds result (consumed first), then data result
      mockPool.pushResult([{ actual_span_secs: 300 }]);
      mockPool.pushResult(mockRows);

      const result = await repo.getDockerStatsForContainer(['abc123'], undefined, from, to);
      expect(result).toEqual(mockRows);
    });
  });

  describe('getServiceKeyForEntity', () => {
    it('should query entity_metadata with correct params', async () => {
      await repo.getServiceKeyForEntity('docker', 'myhost/abc123');

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain("key = 'service_key'");
      expect(mockPool.queries[0].params).toEqual(['docker', 'myhost/abc123']);
    });

    it('should return the service_key value when found', async () => {
      mockPool.pushResult([{ value: 'media-stack/plex' }]);

      const result = await repo.getServiceKeyForEntity('docker', 'myhost/abc123');
      expect(result).toBe('media-stack/plex');
    });

    it('should return null when no entry exists', async () => {
      mockPool.pushResult([]);

      const result = await repo.getServiceKeyForEntity('docker', 'myhost/unknown');
      expect(result).toBeNull();
    });
  });

  describe('getContainerIdsByServiceKey', () => {
    it('should query with source, host prefix, and service_key using SPLIT_PART', async () => {
      await repo.getContainerIdsByServiceKey('docker', 'myhost', 'media-stack/plex');

      expect(mockPool.queries).toHaveLength(1);
      const sql = mockPool.queries[0].sql;
      expect(sql).toContain("key = 'service_key'");
      expect(sql).toContain("SPLIT_PART(entity, '/', 1) = $2");
      expect(sql).toContain("SPLIT_PART(entity, '/', 2) AS container_id");
      expect(sql).not.toContain('LIKE');
      expect(mockPool.queries[0].params).toEqual(['docker', 'myhost', 'media-stack/plex']);
    });

    it('should return container_ids stripped of host prefix', async () => {
      mockPool.pushResult([
        { container_id: 'abc123' },
        { container_id: 'def456' },
      ]);

      const result = await repo.getContainerIdsByServiceKey('docker', 'myhost', 'plex');
      expect(result).toEqual(['abc123', 'def456']);
    });

    it('should return empty array when no containers match', async () => {
      mockPool.pushResult([]);

      const result = await repo.getContainerIdsByServiceKey('docker', 'myhost', 'nonexistent');
      expect(result).toEqual([]);
    });

    it('should use SPLIT_PART instead of LIKE, avoiding wildcard injection from host values', async () => {
      await repo.getContainerIdsByServiceKey('docker', 'my_host%', 'media-stack/plex');

      expect(mockPool.queries).toHaveLength(1);
      const sql = mockPool.queries[0].sql;
      expect(sql).toContain("SPLIT_PART(entity, '/', 1) = $2");
      expect(sql).not.toContain('LIKE');
      expect(mockPool.queries[0].params).toEqual(['docker', 'my_host%', 'media-stack/plex']);
    });
  });

  describe('getLinkedContainerIds', () => {
    it('should self-join entity_metadata to find sibling container_ids by service_key', async () => {
      mockPool.pushResult([
        { container_id: 'abc123' },
        { container_id: 'def456' },
      ]);

      const result = await repo.getLinkedContainerIds('docker', 'myhost/abc123', 'myhost');

      expect(mockPool.queries).toHaveLength(1);
      const sql = mockPool.queries[0].sql;
      expect(sql).toContain('JOIN entity_metadata sibling');
      expect(sql).toContain("me.key = 'service_key'");
      expect(sql).toContain("sibling.key    = 'service_key'");
      expect(sql).toContain("SPLIT_PART(sibling.entity, '/', 1) = $3");
      expect(sql).toContain("SPLIT_PART(sibling.entity, '/', 2) AS container_id");
      expect(mockPool.queries[0].params).toEqual(['docker', 'myhost/abc123', 'myhost']);
      expect(result).toEqual(['abc123', 'def456']);
    });

    it('should return empty array when entity has no service_key', async () => {
      mockPool.pushResult([]);

      const result = await repo.getLinkedContainerIds('docker', 'myhost/unknown', 'myhost');
      expect(result).toEqual([]);
    });
  });

  describe('migrateServiceKeyByName', () => {
    it('should issue UPDATE with SPLIT_PART instead of LIKE', async () => {
      await repo.migrateServiceKeyByName('docker', 'myhost', 'plex', 'media-stack/plex');

      expect(mockPool.queries).toHaveLength(1);
      const sql = mockPool.queries[0].sql;
      expect(sql).toContain('UPDATE entity_metadata');
      expect(sql).toContain("key = 'service_key'");
      expect(sql).toContain("SPLIT_PART(entity, '/', 1) = $2");
      expect(sql).not.toContain('LIKE');
      expect(mockPool.queries[0].params).toEqual(['docker', 'myhost', 'plex', 'media-stack/plex']);
    });
  });

  describe('migrateServiceIcon', () => {
    it('should INSERT icon from old entity to new entity with ON CONFLICT DO NOTHING', async () => {
      await repo.migrateServiceIcon('docker', 'myhost/plex', 'myhost/media-stack/plex');

      expect(mockPool.queries).toHaveLength(1);
      const sql = mockPool.queries[0].sql;
      expect(sql).toContain('INSERT INTO entity_metadata');
      expect(sql).toContain("ON CONFLICT");
      expect(sql).toContain("DO NOTHING");
      expect(sql).toContain("key = 'icon'");
      expect(mockPool.queries[0].params).toEqual(['docker', 'myhost/plex', 'myhost/media-stack/plex']);
    });
  });

  describe('getDockerContainerMetadata', () => {
    it('should query with two LEFT JOINs and COALESCE for icon resolution', async () => {
      await repo.getDockerContainerMetadata('docker');

      expect(mockPool.queries).toHaveLength(1);
      const sql = mockPool.queries[0].sql;
      expect(sql).toContain('service_key_entity');
      expect(sql).toContain('LEFT JOIN entity_metadata icon');
      expect(sql).toContain('LEFT JOIN entity_metadata legacy_icon');
      expect(sql).toContain('COALESCE(icon.value, legacy_icon.value)');
      expect(sql).toContain("sk.key = 'service_key'");
      expect(sql).not.toContain(' OR ');
      expect(mockPool.queries[0].params).toEqual(['docker']);
    });

    it('should return metadata keyed by container_entity', async () => {
      mockPool.pushResult([
        { container_entity: 'myhost/abc123', service_key_entity: 'myhost/plex', icon_slug: 'plex.svg' },
        { container_entity: 'myhost/def456', service_key_entity: 'myhost/media-stack/plex', icon_slug: null },
      ]);

      const result = await repo.getDockerContainerMetadata('docker');
      expect(result.size).toBe(2);
      expect(result.get('myhost/abc123')).toEqual({ serviceKeyEntity: 'myhost/plex', iconSlug: 'plex.svg' });
      expect(result.get('myhost/def456')).toEqual({ serviceKeyEntity: 'myhost/media-stack/plex', iconSlug: null });
    });

    it('should return empty map when no containers have service_key', async () => {
      mockPool.pushResult([]);

      const result = await repo.getDockerContainerMetadata('docker');
      expect(result.size).toBe(0);
    });
  });

  describe('getContainerServiceInfo', () => {
    it('should query with JOIN + COALESCE for icon resolution', async () => {
      mockPool.pushResult([{ service_key: 'media-stack/plex', icon: 'plex.svg' }]);

      const result = await repo.getContainerServiceInfo('docker', 'myhost/abc123');

      expect(mockPool.queries).toHaveLength(1);
      const sql = mockPool.queries[0].sql;
      expect(sql).toContain('LEFT JOIN entity_metadata icon');
      expect(sql).toContain('LEFT JOIN entity_metadata legacy_icon');
      expect(sql).toContain('COALESCE(icon.value, legacy_icon.value)');
      expect(sql).toContain("sk.key = 'service_key'");
      expect(mockPool.queries[0].params).toEqual(['docker', 'myhost/abc123']);
      expect(result).toEqual({ serviceKey: 'media-stack/plex', icon: 'plex.svg' });
    });

    it('should return null icon when no icon exists', async () => {
      mockPool.pushResult([{ service_key: 'plex', icon: null }]);

      const result = await repo.getContainerServiceInfo('docker', 'myhost/abc123');
      expect(result).toEqual({ serviceKey: 'plex', icon: null });
    });

    it('should return null when entity has no service_key', async () => {
      mockPool.pushResult([]);

      const result = await repo.getContainerServiceInfo('docker', 'myhost/unknown');
      expect(result).toBeNull();
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

  describe('insertProxmoxStats', () => {
    it('should skip insert for empty rows', async () => {
      await repo.insertProxmoxStats([]);
      expect(mockPool.queries).toHaveLength(0);
    });

    it('should insert rows with correct parameters', async () => {
      const rows = [
        {
          time: new Date('2024-01-01'),
          host: 'proxmox-host',
          entity_type: 'node' as const,
          node: 'pve1',
          entity_id: 'pve1',
          entity_name: 'pve1',
          status: 'online',
          cpu: 2,
          max_cpu: 8,
          mem: 4e9,
          max_mem: 16e9,
          disk: 50e9,
          max_disk: 500e9,
          uptime: 86400,
          vmid: null,
          netin: null,
          netout: null,
          storage_type: null,
          storage_content: null,
          storage_avail: null,
          storage_shared: null,
          cluster_version: null,
        },
      ];

      await repo.insertProxmoxStats(rows);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('INSERT INTO proxmox_stats');
      expect(mockPool.queries[0].params[0]).toEqual([new Date('2024-01-01')]);
      expect(mockPool.queries[0].params[1]).toEqual(['proxmox-host']);
      expect(mockPool.queries[0].params[2]).toEqual(['node']);
      expect(mockPool.queries[0].params[3]).toEqual(['pve1']);
      expect(mockPool.queries[0].params[4]).toEqual(['pve1']);
    });

    it('should handle multiple rows with mixed entity types', async () => {
      const rows = [
        {
          time: new Date('2024-01-01'),
          host: 'h',
          entity_type: 'cluster' as const,
          node: null,
          entity_id: 'cluster',
          entity_name: 'cluster',
          status: 'quorate',
          cpu: 4,
          max_cpu: 16,
          mem: 8e9,
          max_mem: 32e9,
          disk: 100e9,
          max_disk: 1000e9,
          uptime: null,
          vmid: null,
          netin: null,
          netout: null,
          storage_type: null,
          storage_content: null,
          storage_avail: null,
          storage_shared: null,
          cluster_version: 5,
        },
        {
          time: new Date('2024-01-01'),
          host: 'h',
          entity_type: 'qemu' as const,
          node: 'pve1',
          entity_id: '100',
          entity_name: 'ubuntu-vm',
          status: 'running',
          cpu: 0.5,
          max_cpu: 4,
          mem: 2e9,
          max_mem: 4e9,
          disk: 10e9,
          max_disk: 50e9,
          uptime: 3600,
          vmid: 100,
          netin: 1000000,
          netout: 500000,
          storage_type: null,
          storage_content: null,
          storage_avail: null,
          storage_shared: null,
          cluster_version: null,
        },
        {
          time: new Date('2024-01-01'),
          host: 'h',
          entity_type: 'storage' as const,
          node: 'pve1',
          entity_id: 'pve1/local',
          entity_name: 'local',
          status: 'active',
          cpu: null,
          max_cpu: null,
          mem: null,
          max_mem: null,
          disk: 20e9,
          max_disk: 100e9,
          uptime: null,
          vmid: null,
          netin: null,
          netout: null,
          storage_type: 'dir',
          storage_content: 'rootdir,images',
          storage_avail: 80e9,
          storage_shared: false,
          cluster_version: null,
        },
      ];

      await repo.insertProxmoxStats(rows);

      expect(mockPool.queries).toHaveLength(1);
      // Verify entity_types array
      expect(mockPool.queries[0].params[2]).toEqual(['cluster', 'qemu', 'storage']);
      // Verify vmids array
      expect(mockPool.queries[0].params[14]).toEqual([null, 100, null]);
      // Verify storage_types array
      expect(mockPool.queries[0].params[17]).toEqual([null, null, 'dir']);
      // Verify cluster_versions array
      expect(mockPool.queries[0].params[21]).toEqual([5, null, null]);
    });

    it('should propagate errors', async () => {
      mockPool.setError(new Error('PX DB error'));

      await expect(repo.insertProxmoxStats([{
        time: new Date(),
        host: 'h',
        entity_type: 'cluster',
        node: null,
        entity_id: 'c',
        entity_name: 'c',
        status: 'quorate',
        cpu: 0,
        max_cpu: 0,
        mem: 0,
        max_mem: 0,
        disk: 0,
        max_disk: 0,
        uptime: null,
        vmid: null,
        netin: null,
        netout: null,
        storage_type: null,
        storage_content: null,
        storage_avail: null,
        storage_shared: null,
        cluster_version: null,
      }])).rejects.toThrow('PX DB error');
    });
  });

  describe('getProxmoxStatsSince', () => {
    it('should query with Date parameter', async () => {
      const since = new Date('2024-01-01T00:00:00Z');
      await repo.getProxmoxStatsSince(since);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('proxmox_stats');
      expect(mockPool.queries[0].sql).toContain('time > $1');
      expect(mockPool.queries[0].params).toEqual([since]);
    });

    it('should return rows from query result', async () => {
      const mockRows = [{
        time: new Date(), host: 'h', entity_type: 'node' as const,
        node: 'pve1', entity_id: 'pve1', entity_name: 'pve1',
        status: 'online', cpu: 1, max_cpu: 4,
        mem: null, max_mem: null, disk: null, max_disk: null,
        uptime: null, vmid: null, netin: null, netout: null,
        storage_type: null, storage_content: null, storage_avail: null,
        storage_shared: null, cluster_version: null,
      }];
      mockPool.pushResult(mockRows);

      const result = await repo.getProxmoxStatsSince(new Date());
      expect(result).toEqual(mockRows);
    });
  });

  describe('getProxmoxStatsHistory', () => {
    it('should query with seconds parameter', async () => {
      await repo.getProxmoxStatsHistory(120);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('proxmox_stats');
      expect(mockPool.queries[0].sql).toContain('make_interval');
      expect(mockPool.queries[0].params).toEqual([120]);
    });

    it('should return rows from query result', async () => {
      const mockRows = [{
        time: new Date(), host: 'h', entity_type: 'cluster' as const,
        node: null, entity_id: 'cluster', entity_name: 'test',
        status: null, cpu: null, max_cpu: null,
        mem: null, max_mem: null, disk: null, max_disk: null,
        uptime: null, vmid: null, netin: null, netout: null,
        storage_type: null, storage_content: null, storage_avail: null,
        storage_shared: null, cluster_version: 3,
      }];
      mockPool.pushResult(mockRows);

      const result = await repo.getProxmoxStatsHistory(60);
      expect(result).toEqual(mockRows);
    });
  });

  describe('getEntityIcon', () => {
    it('should query for specific entity icon', async () => {
      mockPool.pushResult([{ value: 'nginx.svg' }]);

      const result = await repo.getEntityIcon('docker', 'host1/nginx');

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('entity_metadata');
      expect(mockPool.queries[0].sql).toContain("key = 'icon'");
      expect(mockPool.queries[0].params).toEqual(['docker', 'host1/nginx']);
      expect(result).toBe('nginx.svg');
    });

    it('should return null when no icon exists', async () => {
      mockPool.pushResult([]);

      const result = await repo.getEntityIcon('docker', 'host1/unknown');
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

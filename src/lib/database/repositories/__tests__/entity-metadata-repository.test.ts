import { describe, it, expect, beforeEach } from 'bun:test';
import { EntityMetadataRepository } from '../entity-metadata-repository';

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

describe('EntityMetadataRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;
  let repo: EntityMetadataRepository;

  beforeEach(() => {
    mockPool = createMockPool();
    repo = new EntityMetadataRepository(mockPool.pool);
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

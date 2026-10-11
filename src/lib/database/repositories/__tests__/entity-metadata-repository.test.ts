import { describe, it, expect, beforeEach } from 'bun:test';
import { EntityMetadataRepository } from '../entity-metadata-repository';
import { createMockPool } from '@/lib/test/mock-pool';

describe('EntityMetadataRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;
  let repo: EntityMetadataRepository;

  beforeEach(() => {
    mockPool = createMockPool();
    repo = new EntityMetadataRepository(mockPool.pool);
  });

  describe('upsertEntityMetadata', () => {
    it('should upsert with correct parameters', async () => {
      await repo.upsertEntityMetadata('host1/container1', 'icon', 'nginx.svg');

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('entity_metadata');
      expect(mockPool.queries[0].sql).toContain('ON CONFLICT');
      expect(mockPool.queries[0].sql).toContain("'docker'");
      expect(mockPool.queries[0].params).toEqual(['host1/container1', 'icon', 'nginx.svg']);
    });

    it('should propagate database errors instead of swallowing them', async () => {
      mockPool.setError(new Error('connection terminated'));

      await expect(
        repo.upsertEntityMetadata('host1/container1', 'icon', 'nginx.svg'),
      ).rejects.toThrow('connection terminated');
    });
  });

  describe('upsertEntityMetadataBatch', () => {
    it('should skip the query for empty entries', async () => {
      await repo.upsertEntityMetadataBatch([]);
      expect(mockPool.queries).toHaveLength(0);
    });

    it('should upsert all entries in a single unnest statement', async () => {
      await repo.upsertEntityMetadataBatch([
        { entity: 'host1/c1', key: 'name', value: 'plex' },
        { entity: 'host1/c1', key: 'image', value: 'plexinc/plex' },
        { entity: 'host1/c1', key: 'service_key', value: 'plex' },
      ]);

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('unnest');
      expect(mockPool.queries[0].sql).toContain('ON CONFLICT');
      expect(mockPool.queries[0].sql).toContain("'docker'");
      expect(mockPool.queries[0].params).toEqual([
        ['host1/c1', 'host1/c1', 'host1/c1'],
        ['name', 'image', 'service_key'],
        ['plex', 'plexinc/plex', 'plex'],
      ]);
    });

    // Guards against silent-swallow regressions: AgentStatsCollector's retry path
    // depends on this error propagating so the container stays unregistered and
    // the next event retries the upsert.
    it('should propagate database errors instead of swallowing them', async () => {
      mockPool.setError(new Error('connection terminated'));

      await expect(
        repo.upsertEntityMetadataBatch([{ entity: 'host1/c1', key: 'name', value: 'plex' }]),
      ).rejects.toThrow('connection terminated');
    });
  });

  describe('getEntityMetadata', () => {
    it('should return empty map for empty entities', async () => {
      const result = await repo.getEntityMetadata([]);
      expect(result.size).toBe(0);
      expect(mockPool.queries).toHaveLength(0);
    });

    it('should query and build metadata map', async () => {
      mockPool.pushResult([
        { entity: 'host1/c1', key: 'icon', value: 'nginx.svg' },
        { entity: 'host1/c1', key: 'label', value: 'Web Server' },
        { entity: 'host1/c2', key: 'icon', value: 'redis.svg' },
      ]);

      const result = await repo.getEntityMetadata(['host1/c1', 'host1/c2']);

      expect(result.size).toBe(2);
      expect(result.get('host1/c1')!.get('icon')).toBe('nginx.svg');
      expect(result.get('host1/c1')!.get('label')).toBe('Web Server');
      expect(result.get('host1/c2')!.get('icon')).toBe('redis.svg');
    });
  });

  describe('getServiceKeyForEntity', () => {
    it('should query entity_metadata with correct params', async () => {
      await repo.getServiceKeyForEntity('myhost/abc123');

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain("key = 'service_key'");
      expect(mockPool.queries[0].params).toEqual(['myhost/abc123']);
    });

    it('should return the service_key value when found', async () => {
      mockPool.pushResult([{ value: 'media-stack/plex' }]);

      const result = await repo.getServiceKeyForEntity('myhost/abc123');
      expect(result).toBe('media-stack/plex');
    });

    it('should return null when no entry exists', async () => {
      mockPool.pushResult([]);

      const result = await repo.getServiceKeyForEntity('myhost/unknown');
      expect(result).toBeNull();
    });
  });

  describe('getContainerIdsByServiceKey', () => {
    it('should query with host prefix and service_key using SPLIT_PART', async () => {
      await repo.getContainerIdsByServiceKey('myhost', 'media-stack/plex');

      expect(mockPool.queries).toHaveLength(1);
      const sql = mockPool.queries[0].sql;
      expect(sql).toContain("key = 'service_key'");
      expect(sql).toContain("SPLIT_PART(entity, '/', 1) = $1");
      expect(sql).toContain("SPLIT_PART(entity, '/', 2) AS container_id");
      expect(sql).not.toContain('LIKE');
      expect(mockPool.queries[0].params).toEqual(['myhost', 'media-stack/plex']);
    });

    it('should return container_ids stripped of host prefix', async () => {
      mockPool.pushResult([
        { container_id: 'abc123' },
        { container_id: 'def456' },
      ]);

      const result = await repo.getContainerIdsByServiceKey('myhost', 'plex');
      expect(result).toEqual(['abc123', 'def456']);
    });

    it('should return empty array when no containers match', async () => {
      mockPool.pushResult([]);

      const result = await repo.getContainerIdsByServiceKey('myhost', 'nonexistent');
      expect(result).toEqual([]);
    });

    it('should use SPLIT_PART instead of LIKE, avoiding wildcard injection from host values', async () => {
      await repo.getContainerIdsByServiceKey('my_host%', 'media-stack/plex');

      expect(mockPool.queries).toHaveLength(1);
      const sql = mockPool.queries[0].sql;
      expect(sql).toContain("SPLIT_PART(entity, '/', 1) = $1");
      expect(sql).not.toContain('LIKE');
      expect(mockPool.queries[0].params).toEqual(['my_host%', 'media-stack/plex']);
    });
  });

  describe('getLinkedContainerIds', () => {
    it('should self-join entity_metadata to find sibling container_ids by service_key', async () => {
      mockPool.pushResult([
        { container_id: 'abc123' },
        { container_id: 'def456' },
      ]);

      const result = await repo.getLinkedContainerIds('myhost/abc123', 'myhost');

      expect(mockPool.queries).toHaveLength(1);
      const sql = mockPool.queries[0].sql;
      expect(sql).toContain('JOIN entity_metadata sibling');
      expect(sql).toContain("me.key = 'service_key'");
      expect(sql).toContain("sibling.key    = 'service_key'");
      expect(sql).toContain("SPLIT_PART(sibling.entity, '/', 1) = $2");
      expect(sql).toContain("SPLIT_PART(sibling.entity, '/', 2) AS container_id");
      expect(mockPool.queries[0].params).toEqual(['myhost/abc123', 'myhost']);
      expect(result).toEqual(['abc123', 'def456']);
    });

    it('should return empty array when entity has no service_key', async () => {
      mockPool.pushResult([]);

      const result = await repo.getLinkedContainerIds('myhost/unknown', 'myhost');
      expect(result).toEqual([]);
    });
  });

  describe('migrateServiceKeyByName', () => {
    it('should issue UPDATE with SPLIT_PART instead of LIKE', async () => {
      await repo.migrateServiceKeyByName({ host: 'myhost', from: 'plex', to: 'media-stack/plex' });

      expect(mockPool.queries).toHaveLength(1);
      const sql = mockPool.queries[0].sql;
      expect(sql).toContain('UPDATE entity_metadata');
      expect(sql).toContain("key = 'service_key'");
      expect(sql).toContain("SPLIT_PART(entity, '/', 1) = $1");
      expect(sql).not.toContain('LIKE');
      expect(mockPool.queries[0].params).toEqual(['myhost', 'plex', 'media-stack/plex']);
    });
  });

  describe('migrateServiceIcon', () => {
    it('should INSERT icon from old entity to new entity with ON CONFLICT DO NOTHING', async () => {
      await repo.migrateServiceIcon({ from: 'myhost/plex', to: 'myhost/media-stack/plex' });

      expect(mockPool.queries).toHaveLength(1);
      const sql = mockPool.queries[0].sql;
      expect(sql).toContain('INSERT INTO entity_metadata');
      expect(sql).toContain("ON CONFLICT");
      expect(sql).toContain("DO NOTHING");
      expect(sql).toContain("key = 'icon'");
      expect(mockPool.queries[0].params).toEqual(['myhost/plex', 'myhost/media-stack/plex']);
    });
  });

  describe('getDockerContainerMetadata', () => {
    it('should query with two LEFT JOINs and COALESCE for icon resolution', async () => {
      await repo.getDockerContainerMetadata();

      expect(mockPool.queries).toHaveLength(1);
      const sql = mockPool.queries[0].sql;
      expect(sql).toContain('service_key_entity');
      expect(sql).toContain('LEFT JOIN entity_metadata icon');
      expect(sql).toContain('LEFT JOIN entity_metadata legacy_icon');
      expect(sql).toContain('COALESCE(icon.value, legacy_icon.value)');
      expect(sql).toContain("sk.key = 'service_key'");
      expect(sql).not.toContain(' OR ');
      expect(mockPool.queries[0].params).toEqual([]);
    });

    it('should return metadata keyed by container_entity', async () => {
      mockPool.pushResult([
        { container_entity: 'myhost/abc123', service_key_entity: 'myhost/plex', icon_slug: 'plex.svg' },
        { container_entity: 'myhost/def456', service_key_entity: 'myhost/media-stack/plex', icon_slug: null },
      ]);

      const result = await repo.getDockerContainerMetadata();
      expect(result.size).toBe(2);
      expect(result.get('myhost/abc123')).toEqual({ serviceKeyEntity: 'myhost/plex', iconSlug: 'plex.svg' });
      expect(result.get('myhost/def456')).toEqual({ serviceKeyEntity: 'myhost/media-stack/plex', iconSlug: null });
    });

    it('should return empty map when no containers have service_key', async () => {
      mockPool.pushResult([]);

      const result = await repo.getDockerContainerMetadata();
      expect(result.size).toBe(0);
    });
  });

  describe('getEntityIcon', () => {
    it('should query for specific entity icon', async () => {
      mockPool.pushResult([{ value: 'nginx.svg' }]);

      const result = await repo.getEntityIcon('host1/nginx');

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('entity_metadata');
      expect(mockPool.queries[0].sql).toContain("key = 'icon'");
      expect(mockPool.queries[0].params).toEqual(['host1/nginx']);
      expect(result).toBe('nginx.svg');
    });

    it('should return null when no icon exists', async () => {
      mockPool.pushResult([]);

      const result = await repo.getEntityIcon('host1/unknown');
      expect(result).toBeNull();
    });
  });

  describe('getSourceIcons', () => {
    it('should query with icon key filter', async () => {
      await repo.getSourceIcons();

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('entity_metadata');
      expect(mockPool.queries[0].sql).toContain("key = 'icon'");
      expect(mockPool.queries[0].params).toEqual([]);
    });

    it('should return a map of entity to icon value', async () => {
      mockPool.pushResult([
        { entity: 'host1/nginx', value: 'nginx.svg' },
        { entity: 'host1/redis', value: 'redis.svg' },
      ]);

      const result = await repo.getSourceIcons();

      expect(result.size).toBe(2);
      expect(result.get('host1/nginx')).toBe('nginx.svg');
      expect(result.get('host1/redis')).toBe('redis.svg');
    });

    it('should return empty map when no icons exist', async () => {
      mockPool.pushResult([]);

      const result = await repo.getSourceIcons();
      expect(result.size).toBe(0);
    });
  });
});

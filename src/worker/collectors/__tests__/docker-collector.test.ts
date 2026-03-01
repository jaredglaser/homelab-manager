import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { Readable } from 'stream';
import { DockerCollector } from '../docker-collector';
import { dockerConnectionManager } from '@/lib/clients/docker-client';
import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { DockerHostConfig } from '@/lib/config/docker-config';
import type { Pool } from 'pg';

// Suppress console output during tests
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function createMockDb() {
  return {
    id: 'test',
    getPool: () => ({}) as unknown as Pool,
    connect: mock(async () => {}),
    isConnected: () => true,
    close: mock(async () => {}),
  };
}

function createMockConfig(): WorkerConfig {
  return {
    enabled: true,
    docker: { enabled: true },
    zfs: { enabled: false },
    proxmox: { enabled: false },
    collection: { interval: 1000 },
  };
}

function createHostConfig(overrides?: Partial<DockerHostConfig>): DockerHostConfig {
  return {
    host: '192.168.1.100',
    port: 2375,
    name: 'test-host',
    protocol: 'http',
    ...overrides,
  };
}

/** Create a minimal Dockerode ContainerStats-like object for JSON stream */
function createMockContainerStats(cpuTotal: number, systemCpu: number) {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: cpuTotal, percpu_usage: [cpuTotal] },
      system_cpu_usage: systemCpu,
      online_cpus: 2,
    },
    precpu_stats: {
      cpu_usage: { total_usage: cpuTotal - 10000000 },
      system_cpu_usage: systemCpu - 1000000000,
    },
    memory_stats: {
      usage: 52428800, // 50MB
      limit: 1073741824, // 1GB
    },
    networks: {
      eth0: { rx_bytes: 1000000, tx_bytes: 500000 },
    },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'read', value: 100000 },
        { op: 'write', value: 50000 },
      ],
    },
  };
}

describe('DockerCollector', () => {
  beforeEach(() => {
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterEach(() => {
    // Restore singleton spies to prevent cross-file pollution
    if (dockerConnectionManager.getClient !== undefined) {
      const spy = dockerConnectionManager.getClient as ReturnType<typeof spyOn>;
      if ('mockRestore' in spy) spy.mockRestore();
    }
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  describe('construction', () => {
    it('should set name from host config', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(db as unknown as DatabaseClient, createMockConfig(), createHostConfig(), controller);

      expect(collector.name).toBe('DockerCollector[test-host]');

      controller.abort();
    });

    it('should set custom name from host config', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(
        db as unknown as DatabaseClient,
        createMockConfig(),
        createHostConfig({ name: 'my-docker-server' }),
        controller,
      );

      expect(collector.name).toBe('DockerCollector[my-docker-server]');

      controller.abort();
    });

    it('should implement AsyncDisposable', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(db as unknown as DatabaseClient, createMockConfig(), createHostConfig(), controller);

      expect(Symbol.asyncDispose in collector).toBe(true);

      await collector[Symbol.asyncDispose]();
    });

    it('should be stoppable', async () => {
      const db = createMockDb();
      const collector = new DockerCollector(db as unknown as DatabaseClient, createMockConfig(), createHostConfig());

      collector.stop();

      // After stop, the internal signal should be aborted
      expect((collector as any).signal.aborted).toBe(true);
    });
  });

  describe('collect()', () => {
    it('should return early when no containers are running', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(db as unknown as DatabaseClient, createMockConfig(), createHostConfig(), controller);

      const closeMock = mock(async () => {});
      const mockDockerClient = {
        getDocker: () => ({
          listContainers: mock(async () => []),
        }),
        close: closeMock,
        isConnected: () => true,
      };
      spyOn(dockerConnectionManager, 'getClient').mockResolvedValue(mockDockerClient as any);

      await (collector as any).collect();

      // Should close the client after finding no containers
      expect(closeMock).toHaveBeenCalled();

      controller.abort();
    });

    it('should stream stats, upsert metadata, and write rows to repository', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(db as unknown as DatabaseClient, createMockConfig(), createHostConfig(), controller);

      // Capture rows written to the repository
      const writtenRows: any[][] = [];
      spyOn((collector as any).repository, 'insertDockerStats').mockImplementation(async (rows: any[]) => {
        writtenRows.push(rows);
      });

      const metadataUpserts: any[] = [];
      spyOn((collector as any).repository, 'upsertEntityMetadata').mockImplementation(
        async (source: string, entity: string, key: string, value: string) => {
          metadataUpserts.push({ source, entity, key, value });
        },
      );

      // Create a stats stream with 2 JSON lines (so rate calculator gets prev + current)
      const stats1 = createMockContainerStats(100000000, 10000000000);
      const stats2 = createMockContainerStats(200000000, 20000000000);
      const statsJson = [JSON.stringify(stats1), JSON.stringify(stats2)].join('\n');
      const statsStream = Readable.from(statsJson);

      const mockContainer = {
        stats: mock(async () => statsStream),
      };

      const containerInfo = {
        Id: 'abc123def456789',
        Names: ['/web-server'],
        Image: 'nginx:latest',
      };

      const mockDocker = {
        listContainers: mock(async () => [containerInfo]),
        getContainer: mock(() => mockContainer),
      };

      const closeMock = mock(async () => {});
      const mockDockerClient = {
        getDocker: () => mockDocker,
        close: closeMock,
        isConnected: () => true,
      };
      spyOn(dockerConnectionManager, 'getClient').mockResolvedValue(mockDockerClient as any);

      await (collector as any).collect();

      // Metadata should be upserted for the container (name + image + service_key)
      expect(metadataUpserts.length).toBe(3);
      expect(metadataUpserts[0]).toEqual({
        source: 'docker',
        entity: 'test-host/abc123def456789',
        key: 'name',
        value: 'web-server', // Leading / stripped by containerInfo helper
      });
      expect(metadataUpserts[1]).toEqual({
        source: 'docker',
        entity: 'test-host/abc123def456789',
        key: 'image',
        value: 'nginx:latest',
      });
      expect(metadataUpserts[2]).toEqual({
        source: 'docker',
        entity: 'test-host/abc123def456789',
        key: 'service_key',
        value: 'web-server', // No compose labels → falls back to container name
      });

      // Stats should have been written — 2 stats events produce 2 rows
      expect(writtenRows.length).toBe(2);

      // Verify row structure: the private containerInfo() helper resolved the name
      const row = writtenRows[0][0];
      expect(row.host).toBe('test-host');
      expect(row.container_id).toBe('abc123def456789');
      expect(row.container_name).toBe('web-server');
      expect(row.image).toBe('nginx:latest');
      expect(typeof row.cpu_percent).toBe('number');
      expect(typeof row.memory_usage).toBe('number');
      expect(typeof row.memory_limit).toBe('number');
      expect(typeof row.memory_percent).toBe('number');
      expect(row.time).toBeInstanceOf(Date);

      // Client should be closed in finally block
      expect(closeMock).toHaveBeenCalled();

      controller.abort();
    });

    it('should use compose labels to compute service_key as project/service', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(db as unknown as DatabaseClient, createMockConfig(), createHostConfig(), controller);

      const metadataUpserts: any[] = [];
      spyOn((collector as any).repository, 'insertDockerStats').mockImplementation(async () => {});
      spyOn((collector as any).repository, 'upsertEntityMetadata').mockImplementation(
        async (source: string, entity: string, key: string, value: string) => {
          metadataUpserts.push({ source, entity, key, value });
        },
      );
      const migrateCalls: any[] = [];
      spyOn((collector as any).repository, 'migrateServiceKeyByName').mockImplementation(
        async (source: string, host: string, oldKey: string, newKey: string) => {
          migrateCalls.push({ source, host, oldKey, newKey });
        },
      );
      const iconMigrateCalls: any[] = [];
      spyOn((collector as any).repository, 'migrateServiceIcon').mockImplementation(
        async (source: string, oldEntity: string, newEntity: string) => {
          iconMigrateCalls.push({ source, oldEntity, newEntity });
        },
      );

      const stats = createMockContainerStats(100000000, 10000000000);
      const statsStream = Readable.from(JSON.stringify(stats));

      const containerInfoWithLabels = {
        Id: 'compose123',
        Names: ['/plex'],
        Image: 'plexinc/pms-docker:latest',
        Labels: {
          'com.docker.compose.project': 'media-stack',
          'com.docker.compose.service': 'plex',
        },
      };

      const mockDocker = {
        listContainers: mock(async () => [containerInfoWithLabels]),
        getContainer: mock(() => ({ stats: mock(async () => statsStream) })),
      };

      spyOn(dockerConnectionManager, 'getClient').mockResolvedValue({
        getDocker: () => mockDocker,
        close: mock(async () => {}),
        isConnected: () => true,
      } as any);

      await (collector as any).collect();

      const serviceKeyUpsert = metadataUpserts.find(u => u.key === 'service_key');
      expect(serviceKeyUpsert).toBeDefined();
      expect(serviceKeyUpsert.value).toBe('media-stack/plex');

      // Migration should be triggered to link old name-only entries
      expect(migrateCalls.length).toBe(1);
      expect(migrateCalls[0]).toEqual({
        source: 'docker',
        host: 'test-host',
        oldKey: 'plex',         // old name-fallback key
        newKey: 'media-stack/plex',
      });

      // Icon should also be migrated from old service_key entity to new
      expect(iconMigrateCalls.length).toBe(1);
      expect(iconMigrateCalls[0]).toEqual({
        source: 'docker',
        oldEntity: 'test-host/plex',
        newEntity: 'test-host/media-stack/plex',
      });

      controller.abort();
    });

    it('should migrate using container name as old key when name differs from compose service', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(db as unknown as DatabaseClient, createMockConfig(), createHostConfig(), controller);

      const metadataUpserts: any[] = [];
      spyOn((collector as any).repository, 'insertDockerStats').mockImplementation(async () => {});
      spyOn((collector as any).repository, 'upsertEntityMetadata').mockImplementation(
        async (source: string, entity: string, key: string, value: string) => {
          metadataUpserts.push({ source, entity, key, value });
        },
      );
      const migrateCalls: any[] = [];
      spyOn((collector as any).repository, 'migrateServiceKeyByName').mockImplementation(
        async (source: string, host: string, oldKey: string, newKey: string) => {
          migrateCalls.push({ source, host, oldKey, newKey });
        },
      );
      const iconMigrateCalls: any[] = [];
      spyOn((collector as any).repository, 'migrateServiceIcon').mockImplementation(
        async (source: string, oldEntity: string, newEntity: string) => {
          iconMigrateCalls.push({ source, oldEntity, newEntity });
        },
      );

      const stats = createMockContainerStats(100000000, 10000000000);
      const statsStream = Readable.from(JSON.stringify(stats));

      // Container name differs from compose service label
      const containerInfoWithMismatch = {
        Id: 'compose456',
        Names: ['/plex-1'],
        Image: 'plexinc/pms-docker:latest',
        Labels: {
          'com.docker.compose.project': 'media-stack',
          'com.docker.compose.service': 'plex',
        },
      };

      const mockDocker = {
        listContainers: mock(async () => [containerInfoWithMismatch]),
        getContainer: mock(() => ({ stats: mock(async () => statsStream) })),
      };

      spyOn(dockerConnectionManager, 'getClient').mockResolvedValue({
        getDocker: () => mockDocker,
        close: mock(async () => {}),
        isConnected: () => true,
      } as any);

      await (collector as any).collect();

      const serviceKeyUpsert = metadataUpserts.find(u => u.key === 'service_key');
      expect(serviceKeyUpsert?.value).toBe('media-stack/plex');

      // Old key must be the container name fallback, not the compose service label
      expect(migrateCalls.length).toBe(1);
      expect(migrateCalls[0]).toEqual({
        source: 'docker',
        host: 'test-host',
        oldKey: 'plex-1',         // container name, not composeService ('plex')
        newKey: 'media-stack/plex',
      });

      expect(iconMigrateCalls.length).toBe(1);
      expect(iconMigrateCalls[0]).toEqual({
        source: 'docker',
        oldEntity: 'test-host/plex-1',
        newEntity: 'test-host/media-stack/plex',
      });

      controller.abort();
    });

    it('should use shortened ID when container name is missing', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(db as unknown as DatabaseClient, createMockConfig(), createHostConfig(), controller);

      const writtenRows: any[][] = [];
      spyOn((collector as any).repository, 'insertDockerStats').mockImplementation(async (rows: any[]) => {
        writtenRows.push(rows);
      });
      spyOn((collector as any).repository, 'upsertEntityMetadata').mockImplementation(async () => {});

      const stats = createMockContainerStats(100000000, 10000000000);
      const statsStream = Readable.from(JSON.stringify(stats));

      const containerInfo = {
        Id: 'deadbeef12345678',
        Names: [], // No name
        Image: 'alpine:latest',
      };

      const mockDocker = {
        listContainers: mock(async () => [containerInfo]),
        getContainer: mock(() => ({ stats: mock(async () => statsStream) })),
      };

      const closeMock = mock(async () => {});
      spyOn(dockerConnectionManager, 'getClient').mockResolvedValue({
        getDocker: () => mockDocker,
        close: closeMock,
        isConnected: () => true,
      } as any);

      await (collector as any).collect();

      expect(writtenRows.length).toBe(1);
      // containerInfo() should fall back to substring(0, 12) when Names is empty
      expect(writtenRows[0][0].container_name).toBe('deadbeef1234');

      controller.abort();
    });
  });

  describe('debug logging', () => {
    it('should support docker debug logging toggle', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(db as unknown as DatabaseClient, createMockConfig(), createHostConfig(), controller);

      // Should not throw
      collector.dockerDebugLogging = true;
      collector.dockerDebugLogging = false;

      controller.abort();
    });

    it('should support db flush debug logging toggle', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(db as unknown as DatabaseClient, createMockConfig(), createHostConfig(), controller);

      collector.dbFlushDebugLogging = true;
      collector.dbFlushDebugLogging = false;

      controller.abort();
    });
  });
});

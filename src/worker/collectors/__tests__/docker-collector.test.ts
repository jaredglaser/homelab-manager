import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { Readable } from 'stream';
import { DockerCollector } from '../docker-collector';
import { dockerConnectionManager } from '@/lib/clients/docker-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { DockerHostConfig } from '@/lib/config/docker-config';

// Suppress console output during tests
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function createMockDb() {
  return {
    id: 'test',
    getPool: () => ({} as any),
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
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  describe('construction', () => {
    it('should set name from host config', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(db as any, createMockConfig(), createHostConfig(), controller);

      expect(collector.name).toBe('DockerCollector[test-host]');

      controller.abort();
    });

    it('should set custom name from host config', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(
        db as any,
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
      const collector = new DockerCollector(db as any, createMockConfig(), createHostConfig(), controller);

      expect(Symbol.asyncDispose in collector).toBe(true);

      await collector[Symbol.asyncDispose]();
    });

    it('should be stoppable', async () => {
      const db = createMockDb();
      const collector = new DockerCollector(db as any, createMockConfig(), createHostConfig());

      collector.stop();

      // After stop, the internal signal should be aborted
      expect((collector as any).signal.aborted).toBe(true);
    });
  });

  describe('collect()', () => {
    it('should return early when no containers are running', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(db as any, createMockConfig(), createHostConfig(), controller);

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
      const collector = new DockerCollector(db as any, createMockConfig(), createHostConfig(), controller);

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

      // Metadata should be upserted for the container (name + image)
      expect(metadataUpserts.length).toBe(2);
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

    it('should use shortened ID when container name is missing', async () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(db as any, createMockConfig(), createHostConfig(), controller);

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
      const collector = new DockerCollector(db as any, createMockConfig(), createHostConfig(), controller);

      // Should not throw
      collector.dockerDebugLogging = true;
      collector.dockerDebugLogging = false;

      controller.abort();
    });

    it('should support db flush debug logging toggle', () => {
      const db = createMockDb();
      const controller = new AbortController();
      const collector = new DockerCollector(db as any, createMockConfig(), createHostConfig(), controller);

      collector.dbFlushDebugLogging = true;
      collector.dbFlushDebugLogging = false;

      controller.abort();
    });
  });
});

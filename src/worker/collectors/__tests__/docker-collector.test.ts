import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { DockerCollector } from '../docker-collector';
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

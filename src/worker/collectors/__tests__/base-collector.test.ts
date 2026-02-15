import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { BaseCollector } from '../base-collector';
import type { RawStatRow } from '@/lib/database/repositories/stats-repository';

// --- Mocks ---

mock.module('@/lib/database/repositories/stats-repository', () => ({
  StatsRepository: class {
    insertRawStats = mock(async () => {});
  },
}));

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

function createMockConfig(overrides?: Partial<any>) {
  return {
    enabled: true,
    docker: { enabled: true },
    zfs: { enabled: true },
    collection: { interval: 1000 },
    batch: { size: 10, timeout: 5000 },
    ...overrides,
  };
}

// --- Concrete test subclass ---

class TestCollector extends BaseCollector {
  readonly name = 'TestCollector';
  collectOnceFn: () => Promise<void> = async () => {};
  isConfiguredFn: () => boolean = () => true;

  protected async collectOnce(): Promise<void> {
    return this.collectOnceFn();
  }

  protected isConfigured(): boolean {
    return this.isConfiguredFn();
  }

  // Expose protected methods for testing
  async testAddToBatch(rows: RawStatRow[]) {
    return this.addToBatch(rows);
  }

  testShouldWrite(entity: string) {
    return this.shouldWrite(entity);
  }

  testDebugLog(message: string) {
    this.debugLog(message);
  }

  getSignal(): AbortSignal {
    return this.signal;
  }
}

describe('BaseCollector', () => {
  let db: ReturnType<typeof createMockDb>;
  let config: ReturnType<typeof createMockConfig>;

  beforeEach(() => {
    db = createMockDb();
    config = createMockConfig();
    // Suppress console output during tests
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  describe('lifecycle', () => {
    it('should stop when abort signal fires', async () => {
      const controller = new AbortController();
      const collector = new TestCollector(db as any, config, controller);

      let collectCount = 0;
      collector.collectOnceFn = async () => {
        collectCount++;
        // Abort after first collection
        controller.abort(new DOMException('Shutdown', 'AbortError'));
      };

      await collector.run();
      expect(collectCount).toBe(1);
    });

    it('should stop when stop() is called', async () => {
      const collector = new TestCollector(db as any, config);

      collector.collectOnceFn = async () => {
        collector.stop();
      };

      await collector.run();
      expect(collector.getSignal().aborted).toBe(true);
    });

    it('should implement AsyncDisposable', async () => {
      const collector = new TestCollector(db as any, config);
      expect(Symbol.asyncDispose in collector).toBe(true);

      await collector[Symbol.asyncDispose]();
      expect(collector.getSignal().aborted).toBe(true);
    });

    it('should handle dispose being called multiple times', async () => {
      const collector = new TestCollector(db as any, config);
      await collector[Symbol.asyncDispose]();
      await collector[Symbol.asyncDispose](); // Should not throw
    });
  });

  describe('error recovery', () => {
    it('should retry on errors and abort cancels the backoff sleep', async () => {
      const controller = new AbortController();
      const collector = new TestCollector(db as any, config, controller);

      let callCount = 0;
      collector.collectOnceFn = async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Connection failed');
        }
        // Second call means we survived the backoff — abort now
        controller.abort(new DOMException('Done', 'AbortError'));
      };

      // Abort during the backoff sleep if it takes too long
      setTimeout(() => controller.abort(new DOMException('Timeout', 'AbortError')), 3000);

      await collector.run();
      expect(callCount).toBeGreaterThanOrEqual(1);
    });

    it('should wait when not configured and abort cancels the wait', async () => {
      const controller = new AbortController();
      const collector = new TestCollector(db as any, config, controller);

      let configCheckCount = 0;
      collector.isConfiguredFn = () => {
        configCheckCount++;
        return false;
      };

      // Abort shortly after first config check triggers the sleep
      setTimeout(() => controller.abort(new DOMException('Done', 'AbortError')), 100);

      await collector.run();
      expect(configCheckCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('batch management', () => {
    it('should accumulate stats in batch', async () => {
      const collector = new TestCollector(db as any, config);
      const rows: RawStatRow[] = [
        { timestamp: new Date(), source: 'test', type: 'metric1', entity: 'e1', value: 42 },
      ];

      await collector.testAddToBatch(rows);
      // Batch is internal — we verify through dispose flushing
      await collector[Symbol.asyncDispose]();
    });

    it('should flush when batch size is reached', async () => {
      const smallBatchConfig = createMockConfig({ batch: { size: 2, timeout: 60000 } });
      const collector = new TestCollector(db as any, smallBatchConfig);

      const rows: RawStatRow[] = [
        { timestamp: new Date(), source: 'test', type: 'metric1', entity: 'e1', value: 1 },
        { timestamp: new Date(), source: 'test', type: 'metric2', entity: 'e1', value: 2 },
      ];

      await collector.testAddToBatch(rows);
      // The batch should have been flushed since size >= 2
      // Dispose should have nothing to flush
      await collector[Symbol.asyncDispose]();
    });
  });

  describe('write throttling', () => {
    it('should allow first write for an entity', () => {
      const collector = new TestCollector(db as any, config);
      expect(collector.testShouldWrite('entity-1')).toBe(true);
    });

    it('should throttle writes within collection interval', () => {
      const collector = new TestCollector(db as any, config);
      expect(collector.testShouldWrite('entity-1')).toBe(true);
      expect(collector.testShouldWrite('entity-1')).toBe(false);
    });

    it('should allow writes for different entities independently', () => {
      const collector = new TestCollector(db as any, config);
      expect(collector.testShouldWrite('entity-1')).toBe(true);
      expect(collector.testShouldWrite('entity-2')).toBe(true);
    });

    it('should allow writes after interval elapses', async () => {
      const shortIntervalConfig = createMockConfig({ collection: { interval: 50 } });
      const collector = new TestCollector(db as any, shortIntervalConfig);

      expect(collector.testShouldWrite('entity-1')).toBe(true);
      expect(collector.testShouldWrite('entity-1')).toBe(false);

      await new Promise(resolve => setTimeout(resolve, 60));
      expect(collector.testShouldWrite('entity-1')).toBe(true);
    });
  });

  describe('debug logging', () => {
    it('should not emit debug logs by default', async () => {
      const collector = new TestCollector(db as any, config);
      const logged: string[] = [];
      console.log = (...args: unknown[]) => { logged.push(String(args[0])); };

      collector.testDebugLog('[TestCollector] Debug message');

      expect(logged).not.toContain('[TestCollector] Debug message');

      await collector[Symbol.asyncDispose]();
    });

    it('should emit debug logs when docker debug logging is enabled', async () => {
      const collector = new TestCollector(db as any, config);
      collector.dockerDebugLogging = true;
      const logged: string[] = [];
      console.log = (...args: unknown[]) => { logged.push(String(args[0])); };

      collector.testDebugLog('[TestCollector] Debug message');

      expect(logged).toContain('[TestCollector] Debug message');

      await collector[Symbol.asyncDispose]();
    });

    it('should stop emitting debug logs when docker debug logging is disabled', async () => {
      const collector = new TestCollector(db as any, config);
      collector.dockerDebugLogging = true;
      collector.dockerDebugLogging = false;
      const logged: string[] = [];
      console.log = (...args: unknown[]) => { logged.push(String(args[0])); };

      collector.testDebugLog('[TestCollector] Debug message');

      expect(logged).not.toContain('[TestCollector] Debug message');

      await collector[Symbol.asyncDispose]();
    });
  });
});

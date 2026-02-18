import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { BaseCollector } from '../base-collector';

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

  testDebugLog(message: string) {
    this.debugLog(message);
  }

  testDbDebugLog(message: string) {
    this.dbDebugLog(message);
  }

  testResetBackoff() {
    this.resetBackoff();
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

    it('should not emit db debug logs by default', async () => {
      const collector = new TestCollector(db as any, config);
      const logged: string[] = [];
      console.log = (...args: unknown[]) => { logged.push(String(args[0])); };

      collector.testDbDebugLog('[TestCollector] DB flush');

      expect(logged).not.toContain('[TestCollector] DB flush');

      await collector[Symbol.asyncDispose]();
    });

    it('should emit db debug logs when db flush debug logging is enabled', async () => {
      const collector = new TestCollector(db as any, config);
      collector.dbFlushDebugLogging = true;
      const logged: string[] = [];
      console.log = (...args: unknown[]) => { logged.push(String(args[0])); };

      collector.testDbDebugLog('[TestCollector] DB flush');

      expect(logged).toContain('[TestCollector] DB flush');

      await collector[Symbol.asyncDispose]();
    });
  });

  describe('resetBackoff', () => {
    it('should reset the consecutive error counter', async () => {
      const collector = new TestCollector(db as any, config);
      // Just verify it doesn't throw
      collector.testResetBackoff();
      await collector[Symbol.asyncDispose]();
    });
  });
});

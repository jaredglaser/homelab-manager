import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { WorkerConfig } from '@/lib/config/worker-config';

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

function createWorkerConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return {
    enabled: true,
    docker: { enabled: false },
    zfs: { enabled: false },
    collection: { interval: 1000 },
    ...overrides,
  };
}

describe('createCollectors', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it('should return empty collectors when both docker and zfs are disabled', async () => {
    // Dynamic import so module-level mocks apply
    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ docker: { enabled: false }, zfs: { enabled: false } });
    const { collectors, runners } = createCollectors(db as any, config, controller, stack);

    expect(collectors).toHaveLength(0);
    expect(runners).toHaveLength(0);

    controller.abort();
  });

  it('should log disabled messages when collectors are disabled', async () => {
    const { createCollectors } = await import('../collector-factory');
    const controller = new AbortController();
    await using stack = new AsyncDisposableStack();

    const config = createWorkerConfig({ docker: { enabled: false }, zfs: { enabled: false } });
    createCollectors(db as any, config, controller, stack);

    const logCalls = (console.log as any).mock.calls.map((c: any) => c[0]);
    expect(logCalls).toContain('[Worker] Docker collector disabled');
    expect(logCalls).toContain('[Worker] ZFS collector disabled');

    controller.abort();
  });
});

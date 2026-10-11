import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { SettingsBroadcastService } from '../settings-broadcast-service';
import type { SettingsSSEMessage } from '@/types/settings';
import type { PoolClient } from 'pg';
import { waitForCondition } from '@/lib/test/wait-for-condition';
import { mockSetTimeout } from '@/lib/test/mock-timers';

type NotificationHandler = (msg: { channel: string; payload?: string }) => void;
type ErrorHandler = (err: Error) => void;

interface MockPoolClient {
  querySql: string | null;
  released: boolean;
  notificationHandlers: NotificationHandler[];
  errorHandlers: ErrorHandler[];
  on: ReturnType<typeof mock>;
  query: ReturnType<typeof mock>;
  release: ReturnType<typeof mock>;
  removeAllListeners: ReturnType<typeof mock>;
  emit: (event: 'notification' | 'error', arg: unknown) => void;
}

function createMockPoolClient(): MockPoolClient {
  const client: MockPoolClient = {
    querySql: null,
    released: false,
    notificationHandlers: [],
    errorHandlers: [],
    on: mock((event: string, handler: unknown) => {
      if (event === 'notification') client.notificationHandlers.push(handler as NotificationHandler);
      if (event === 'error') client.errorHandlers.push(handler as ErrorHandler);
    }),
    query: mock(async (sql: string) => {
      client.querySql = sql;
      return { rows: [], rowCount: 0 };
    }),
    release: mock(() => { client.released = true; }),
    removeAllListeners: mock(() => {}),
    emit(event, arg) {
      if (event === 'notification') {
        for (const h of client.notificationHandlers) h(arg as { channel: string; payload?: string });
      }
      if (event === 'error') {
        for (const h of client.errorHandlers) h(arg as Error);
      }
    },
  };
  return client;
}

describe('SettingsBroadcastService', () => {
  let poolClient: MockPoolClient;
  let service: SettingsBroadcastService;

  beforeEach(() => {
    poolClient = createMockPoolClient();
    service = new SettingsBroadcastService({
      getPoolClient: async () => poolClient as unknown as PoolClient,
      loadAllSettings: async () => new Map([['theme', 'dark']]),
      loadSingleSetting: async (key) => (key === 'theme' ? 'light' : null),
    });
  });

  afterEach(async () => {
    await service.stop();
  });

  it('sends init payload with settings on subscribe', async () => {
    const received: SettingsSSEMessage[] = [];
    service.subscribe((m) => received.push(m));

    await waitForCondition(() => received.length > 0);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('init');
    if (received[0].type === 'init') {
      expect(received[0].settings).toEqual({ theme: 'dark' });
    }
  });

  it('issues LISTEN settings_change on subscribe', async () => {
    service.subscribe(() => {});
    await waitForCondition(() => poolClient.querySql !== null);
    expect(poolClient.querySql).toBe('LISTEN settings_change');
  });

  it('broadcasts change event from NOTIFY payload', async () => {
    const received: SettingsSSEMessage[] = [];
    service.subscribe((m) => received.push(m));
    await waitForCondition(() => poolClient.notificationHandlers.length > 0);

    poolClient.emit('notification', { channel: 'settings_change', payload: 'theme' });
    await waitForCondition(() => received.some((m) => m.type === 'change'));

    const change = received.find((m) => m.type === 'change');
    expect(change).toBeDefined();
    if (change?.type === 'change') {
      expect(change.key).toBe('theme');
      expect(change.value).toBe('light');
    }
  });

  it('ignores NOTIFY on unrelated channels', async () => {
    const received: SettingsSSEMessage[] = [];
    service.subscribe((m) => received.push(m));
    await waitForCondition(() => poolClient.notificationHandlers.length > 0);

    poolClient.emit('notification', { channel: 'other_channel', payload: 'theme' });
    // channel filter is synchronous; an unrelated channel is a same-tick no-op
    expect(received.filter((m) => m.type === 'change')).toHaveLength(0);
  });

  it('stops listening when last subscriber unsubscribes', async () => {
    const unsub = service.subscribe(() => {});
    await waitForCondition(() => poolClient.notificationHandlers.length > 0);

    expect(poolClient.released).toBe(false);
    unsub();
    await waitForCondition(() => poolClient.released);
    expect(poolClient.released).toBe(true);
  });

  describe('reconnect backoff', () => {
    let setTimeoutSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      // Default: do not auto-fire timers; tests opt in per case below.
      setTimeoutSpy = spyOn(globalThis, 'setTimeout');
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
    });

    it('schedules reconnect with 500ms base delay on first listener error', async () => {
      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      try {
        service.subscribe(() => {});
        await waitForCondition(() => poolClient.notificationHandlers.length > 0);

        // error handler schedules reconnect via synchronous setTimeout; no wait needed.
        setTimeoutSpy.mockClear();
        poolClient.emit('error', new Error('connection reset'));

        const backoffCalls = (setTimeoutSpy.mock.calls as Array<[unknown, unknown?]>).filter(
          ([, delay]) => typeof delay === 'number' && delay >= 100,
        );
        expect(backoffCalls).toHaveLength(1);
        expect(backoffCalls[0][1]).toBe(500);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('follows the exponential sequence on repeated failures, capped at 30_000', async () => {
      // Every getPoolClient() rejects, driving repeated retries.
      const failingService = new SettingsBroadcastService({
        getPoolClient: async () => { throw new Error('refused'); },
        loadAllSettings: async () => new Map(),
        loadSingleSetting: async () => null,
      });

      // Auto-fire timers via microtask so the retry chain runs inline.
      const timers = mockSetTimeout({
        onSchedule: (timer) => queueMicrotask(() => { void timers.fire(timer); }),
      });

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      const backoffDelaysAtLeast3 = () => timers.delays.filter((d) => d >= 100).length >= 3;

      try {
        failingService.subscribe(() => {});
        // Allow several retry cycles to elapse.
        await waitForCondition(backoffDelaysAtLeast3);

        const backoffDelays = timers.delays.filter((d) => d >= 100);

        // First few values should match the exponential sequence.
        expect(backoffDelays[0]).toBe(500);
        expect(backoffDelays[1]).toBe(1000);
        expect(backoffDelays[2]).toBe(2000);
        // All values are capped at 30_000.
        expect(Math.max(...backoffDelays)).toBeLessThanOrEqual(30_000);
      } finally {
        consoleSpy.mockRestore();
        await failingService.stop();
        timers.restore();
      }
    });

    it('resets backoff counter after a successful reconnect', async () => {
      const client1 = poolClient;
      const client2 = createMockPoolClient();
      const client3 = createMockPoolClient();
      let connectCount = 0;
      // `reconnecting` resets to false *before* resyncAllSubscribers() runs, so
      // loadAllSettings call count is a safer "reconnect fully completed" proxy
      // than connectCount, which bumps while `reconnecting` may still read true.
      let loadAllSettingsCallCount = 0;

      const resetService = new SettingsBroadcastService({
        getPoolClient: async () => {
          connectCount++;
          if (connectCount === 1) return client1 as unknown as PoolClient;
          if (connectCount === 2) return client2 as unknown as PoolClient;
          return client3 as unknown as PoolClient;
        },
        loadAllSettings: async () => { loadAllSettingsCallCount++; return new Map(); },
        loadSingleSetting: async () => null,
      });

      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      // Auto-fire timers via microtask so the retry chain runs inline.
      const timers = mockSetTimeout({
        onSchedule: (timer) => queueMicrotask(() => { void timers.fire(timer); }),
      });

      try {
        resetService.subscribe(() => {});
        await waitForCondition(() => client1.notificationHandlers.length > 0);

        // First disconnect cycle: client1 errors → retry schedules delay 500
        // → reconnect callback runs → client2 connects successfully → counter resets.
        client1.emit('error', new Error('first disconnect'));
        await waitForCondition(() => loadAllSettingsCallCount >= 2);

        expect(timers.delays.filter((d) => d >= 100)[0]).toBe(500);
        expect(connectCount).toBeGreaterThanOrEqual(2);

        // After the successful reconnect on client2, a second disconnect should
        // again start from the base 500ms; if the counter weren't reset it
        // would continue from 1000ms.
        const resetMark = timers.delays.length;
        client2.emit('error', new Error('second disconnect'));
        await waitForCondition(() => loadAllSettingsCallCount >= 3);

        expect(timers.delays.slice(resetMark).filter((d) => d >= 100)[0]).toBe(500);
      } finally {
        consoleSpy.mockRestore();
        await resetService.stop();
        timers.restore();
      }
    });
  });
});

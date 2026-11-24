import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { SettingsBroadcastService } from '../settings-broadcast-service';
import type { SettingsWireMessage } from '@/types/settings';
import type { PoolClient } from 'pg';
import { waitForCondition } from '@/lib/test/wait-for-condition';
import { mockSetTimeout } from '@/lib/test/mock-timers';
import { mockModule } from '@/lib/test/mock-module';

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
    const received: SettingsWireMessage[] = [];
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
    const received: SettingsWireMessage[] = [];
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
    const received: SettingsWireMessage[] = [];
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

describe('SettingsBroadcastService with its default database wiring', () => {
  it('listens on a pooled connection and reads settings through the settings repository', async () => {
    const poolClient = createMockPoolClient();
    const pool = { connect: mock(() => Promise.resolve(poolClient)) };
    const repoPools: unknown[] = [];
    void mock.module('@/lib/clients/database-client', () => ({
      databaseConnectionManager: { getClient: () => Promise.resolve({ getPool: () => pool }) },
    }));
    mockModule<typeof import('@/lib/database/repositories/settings-repository')>('@/lib/database/repositories/settings-repository', (real) => ({
      ...real,
      SettingsRepository: class {
        constructor(p: unknown) {
          repoPools.push(p);
        }
        getAll = () => Promise.resolve(new Map([['theme', 'dark']]));
        get = (key: string) => Promise.resolve(key === 'theme' ? 'light' : null);
      },
    }));
    const service = new SettingsBroadcastService();
    const received: SettingsWireMessage[] = [];
    try {
      service.subscribe((m) => received.push(m), undefined);
      await waitForCondition(() => poolClient.querySql !== null && received.length > 0);

      expect(poolClient.querySql).toBe('LISTEN settings_change');
      expect(received).toEqual([{ type: 'init', settings: { theme: 'dark' } }]);

      poolClient.emit('notification', { channel: 'settings_change', payload: 'theme' });
      await waitForCondition(() => received.length > 1);

      expect(received[1]).toEqual({ type: 'change', key: 'theme', value: 'light' });
      expect(repoPools).toEqual([pool, pool]);
    } finally {
      await service.stop();
    }
  });
});

describe('SettingsBroadcastService scoped by user', () => {
  let poolClient: MockPoolClient;
  let service: SettingsBroadcastService<number>;
  const stored = new Map<number, Map<string, string>>();

  beforeEach(() => {
    poolClient = createMockPoolClient();
    stored.clear();
    stored.set(1, new Map([['general/use12HourTime', 'false']]));
    stored.set(2, new Map([['general/use12HourTime', 'true']]));
    service = new SettingsBroadcastService<number>({
      getPoolClient: () => Promise.resolve(poolClient as unknown as PoolClient),
      channel: 'user_settings_change',
      parseNotification: (payload) => {
        const [id, key] = payload.split(':');
        return id && key ? { scope: Number(id), key } : null;
      },
      loadAllSettings: (userId) => Promise.resolve(new Map(stored.get(userId))),
      loadSingleSetting: (key, userId) => Promise.resolve(stored.get(userId)?.get(key) ?? null),
    });
  });

  afterEach(async () => {
    await service.stop();
  });

  it("sends each subscriber its own user's init, listening on the user channel", async () => {
    const one: SettingsWireMessage[] = [];
    const two: SettingsWireMessage[] = [];
    service.subscribe((m) => one.push(m), 1);
    service.subscribe((m) => two.push(m), 2);
    await waitForCondition(() => one.length > 0 && two.length > 0 && poolClient.querySql !== null);

    expect(poolClient.querySql).toBe('LISTEN user_settings_change');
    expect(one).toEqual([{ type: 'init', settings: { 'general/use12HourTime': 'false' } }]);
    expect(two).toEqual([{ type: 'init', settings: { 'general/use12HourTime': 'true' } }]);
  });

  it('delivers a change only to subscribers of the user it names', async () => {
    const one: SettingsWireMessage[] = [];
    const two: SettingsWireMessage[] = [];
    service.subscribe((m) => one.push(m), 1);
    service.subscribe((m) => two.push(m), 2);
    await waitForCondition(() => one.length > 0 && two.length > 0 && poolClient.notificationHandlers.length > 0);

    stored.get(2)?.set('general/use12HourTime', 'false');
    poolClient.emit('notification', { channel: 'user_settings_change', payload: '2:general/use12HourTime' });
    poolClient.emit('notification', { channel: 'user_settings_change', payload: 'garbage' });
    await waitForCondition(() => two.length > 1);

    expect(two[1]).toEqual({ type: 'change', key: 'general/use12HourTime', value: 'false' });
    expect(one).toHaveLength(1);
  });

  it('skips the database read for a change to a user with no open client', async () => {
    const reads: string[] = [];
    const counting = new SettingsBroadcastService<number>({
      getPoolClient: () => Promise.resolve(poolClient as unknown as PoolClient),
      channel: 'user_settings_change',
      parseNotification: (payload) => ({ scope: Number(payload.split(':')[0]), key: payload.split(':')[1] }),
      loadAllSettings: (userId) => Promise.resolve(new Map(stored.get(userId))),
      loadSingleSetting: (key, userId) => {
        reads.push(`${userId}:${key}`);
        return Promise.resolve(stored.get(userId)?.get(key) ?? null);
      },
    });
    const one: SettingsWireMessage[] = [];
    counting.subscribe((m) => one.push(m), 1);
    await waitForCondition(() => one.length > 0 && poolClient.notificationHandlers.length > 0);

    poolClient.emit('notification', { channel: 'user_settings_change', payload: '2:general/use12HourTime' });
    poolClient.emit('notification', { channel: 'user_settings_change', payload: '1:general/use12HourTime' });
    await waitForCondition(() => one.length > 1);

    expect(reads).toEqual(['1:general/use12HourTime']);
    await counting.stop();
  });
});

describe('SettingsBroadcastService re-subscribe while connecting', () => {
  it('ends with one LISTEN client when a re-subscribe lands while the first client is still being acquired', async () => {
    const clients = [createMockPoolClient(), createMockPoolClient()];
    const acquisitions: ((client: PoolClient) => void)[] = [];
    const service = new SettingsBroadcastService({
      getPoolClient: () => new Promise<PoolClient>((resolve) => acquisitions.push(resolve)),
      loadAllSettings: () => Promise.resolve(new Map([['theme', 'dark']])),
      loadSingleSetting: () => Promise.resolve('light'),
    });

    service.subscribe(() => undefined, undefined)();
    const received: SettingsWireMessage[] = [];
    service.subscribe((m) => received.push(m), undefined);
    acquisitions.forEach((resolve, i) => resolve(clients[i] as unknown as PoolClient));
    const handed = clients.slice(0, acquisitions.length);
    await waitForCondition(() => received.length >= 1 && handed.every((c) => c.released || c.querySql !== null));

    const live = handed.filter((c) => c.querySql === 'LISTEN settings_change' && !c.released);
    expect(live).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'init', settings: { theme: 'dark' } });

    live[0].emit('notification', { channel: 'settings_change', payload: 'theme' });
    await waitForCondition(() => received.length >= 2);
    expect(received[1]).toEqual({ type: 'change', key: 'theme', value: 'light' });
    await service.stop();
  });

  it('ends with one LISTEN client when a re-subscribe lands while a reconnect attempt is acquiring its client', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const reconnects: (() => void)[] = [];
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if ((ms ?? 0) < 500) return realSetTimeout(fn, ms);
      reconnects.push(fn);
      return reconnects.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    const clients: MockPoolClient[] = [];
    const acquisitions: ((client: PoolClient) => void)[] = [];
    let connects = 0;
    const service = new SettingsBroadcastService({
      getPoolClient: () => {
        connects++;
        if (connects === 1) return Promise.reject(new Error('db down'));
        return new Promise<PoolClient>((resolve) => acquisitions.push(resolve));
      },
      loadAllSettings: () => Promise.resolve(new Map([['theme', 'dark']])),
      loadSingleSetting: () => Promise.resolve('light'),
    });
    const handOut = (resolve: (client: PoolClient) => void) => {
      const client = createMockPoolClient();
      clients.push(client);
      resolve(client as unknown as PoolClient);
    };

    try {
      const unsubscribeFirst = service.subscribe(() => undefined, undefined);
      await waitForCondition(() => reconnects.length === 1);
      reconnects.shift()?.();
      await waitForCondition(() => acquisitions.length === 1);
      unsubscribeFirst();
      const received: SettingsWireMessage[] = [];
      service.subscribe((m) => received.push(m), undefined);
      await waitForCondition(() => acquisitions.length === 2);

      handOut(acquisitions[0]);
      await waitForCondition(() => clients[0].released);
      handOut(acquisitions[1]);
      await waitForCondition(() => received.length >= 1 && clients[1].querySql !== null);
      while (reconnects.length > 0) {
        const pending = acquisitions.length;
        reconnects.shift()?.();
        await waitForCondition(() => acquisitions.length > pending);
        handOut(acquisitions[pending]);
        await waitForCondition(() => clients[pending].querySql !== null || clients[pending].released);
      }

      const live = clients.filter((c) => c.querySql === 'LISTEN settings_change' && !c.released);
      expect(live).toHaveLength(1);
      live[0].emit('notification', { channel: 'settings_change', payload: 'theme' });
      await waitForCondition(() => received.length >= 2);
      expect(received.filter((m) => m.type === 'change')).toEqual([{ type: 'change', key: 'theme', value: 'light' }]);
    } finally {
      await service.stop();
      setTimeoutSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { DatabaseConfig } from '@/lib/clients/database-client';
import type { SettingsRepository } from '@/lib/database/repositories/settings-repository';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { SettingsListener, type SettingChangeHandler } from '../settings-listener';

// Suppress console output during tests
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function createMockDbConfig(): DatabaseConfig {
  return {
    host: 'localhost',
    port: 5432,
    database: 'test',
    user: 'test',
    password: 'test',
  };
}

function createMockSettingsRepo(values: Record<string, string | null> = {}) {
  return {
    get: mock(async (key: string) => values[key] ?? null),
    getAll: mock(async () => new Map<string, string>()),
    set: mock(async (_key: string, _value: string) => {}),
  };
}

/** Mock the internal pg.Client on a SettingsListener, with optional custom `on` handler */
function setupPgClientMocks(
  listener: SettingsListener,
  onImpl?: (event: string, cb: any) => any,
) {
  const pgClient = (listener as any).client; // Access private for test
  spyOn(pgClient, 'connect').mockResolvedValue(undefined);
  spyOn(pgClient, 'query').mockResolvedValue({ rows: [] });
  if (onImpl) {
    spyOn(pgClient, 'on').mockImplementation(onImpl);
  } else {
    spyOn(pgClient, 'on').mockReturnValue(pgClient);
  }
  const endSpy = spyOn(pgClient, 'end').mockResolvedValue(undefined);
  return { pgClient, endSpy };
}

describe('SettingsListener', () => {
  beforeEach(() => {
    console.log = mock(() => {});
    console.error = mock(() => {});
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it('should construct with all required parameters', () => {
    const dbConfig = createMockDbConfig();
    const repo = createMockSettingsRepo();
    const handler: SettingChangeHandler = mock(() => {});
    const controller = new AbortController();

    const listener = new SettingsListener(
      dbConfig,
      repo as unknown as SettingsRepository,
      [SETTINGS_KEYS.developer.dockerDebugLogging],
      handler,
      controller.signal,
    );

    expect(listener).toBeDefined();
    expect(Symbol.asyncDispose in listener).toBe(true);

    controller.abort();
  });

  it('should implement AsyncDisposable without errors when not started', async () => {
    const dbConfig = createMockDbConfig();
    const repo = createMockSettingsRepo();
    const handler: SettingChangeHandler = mock(() => {});
    const controller = new AbortController();

    const listener = new SettingsListener(
      dbConfig,
      repo as unknown as SettingsRepository,
      [SETTINGS_KEYS.developer.dockerDebugLogging],
      handler,
      controller.signal,
    );

    // Dispose without start should not throw
    await listener[Symbol.asyncDispose]();
    controller.abort();
  });

  it('should export SettingChangeHandler type', async () => {
    // Type-level test — if this compiles, the type is exported correctly
    const handler: SettingChangeHandler = (_key: string, _value: string | null) => {};
    expect(typeof handler).toBe('function');
  });

  describe('start()', () => {
    it('should connect, listen, and load initial values', async () => {
      const dbConfig = createMockDbConfig();
      const watchKeys = [SETTINGS_KEYS.developer.dockerDebugLogging];
      const repo = createMockSettingsRepo({ [watchKeys[0]]: 'true' });
      const handler: SettingChangeHandler = mock(() => {});
      const controller = new AbortController();

      const listener = new SettingsListener(
        dbConfig,
        repo as unknown as SettingsRepository,
        watchKeys,
        handler,
        controller.signal,
      );

      const { pgClient } = setupPgClientMocks(listener);

      await listener.start();

      // Should have connected
      expect(pgClient.connect).toHaveBeenCalled();
      // Should have run LISTEN query
      expect(pgClient.query).toHaveBeenCalledWith('LISTEN settings_change');
      // Should have loaded initial values via repo.get
      expect(repo.get).toHaveBeenCalledWith(watchKeys[0]);
      // Should have called handler with initial value
      expect(handler).toHaveBeenCalledWith(watchKeys[0], 'true');

      controller.abort();
      await listener[Symbol.asyncDispose]();
    });

    it('should call end on dispose when started', async () => {
      const dbConfig = createMockDbConfig();
      const repo = createMockSettingsRepo();
      const handler: SettingChangeHandler = mock(() => {});
      const controller = new AbortController();

      const listener = new SettingsListener(
        dbConfig,
        repo as unknown as SettingsRepository,
        [SETTINGS_KEYS.developer.dockerDebugLogging],
        handler,
        controller.signal,
      );

      const { endSpy } = setupPgClientMocks(listener);

      await listener.start();
      await listener[Symbol.asyncDispose]();

      expect(endSpy).toHaveBeenCalled();

      controller.abort();
    });

    it('should handle notification for watched key', async () => {
      const dbConfig = createMockDbConfig();
      const watchKey = SETTINGS_KEYS.developer.dockerDebugLogging;
      const repo = createMockSettingsRepo({ [watchKey]: 'false' });
      const handler: SettingChangeHandler = mock(() => {});
      const controller = new AbortController();

      const listener = new SettingsListener(
        dbConfig,
        repo as unknown as SettingsRepository,
        [watchKey],
        handler,
        controller.signal,
      );

      let notificationHandler: ((msg: any) => void) | undefined;
      const { pgClient } = setupPgClientMocks(listener, (event: string, cb: any) => {
        if (event === 'notification') notificationHandler = cb;
        return pgClient;
      });

      await listener.start();

      // Reset handler call count from initial load
      (handler as any).mockClear();

      // Now update the repo value
      repo.get.mockResolvedValue('true');

      // Simulate notification
      expect(notificationHandler).toBeDefined();
      await notificationHandler!({ payload: watchKey });

      expect(repo.get).toHaveBeenCalledWith(watchKey);
      expect(handler).toHaveBeenCalledWith(watchKey, 'true');

      controller.abort();
      await listener[Symbol.asyncDispose]();
    });

    it('should ignore notifications for unwatched keys', async () => {
      const dbConfig = createMockDbConfig();
      const watchKey = SETTINGS_KEYS.developer.dockerDebugLogging;
      const repo = createMockSettingsRepo();
      const handler: SettingChangeHandler = mock(() => {});
      const controller = new AbortController();

      const listener = new SettingsListener(
        dbConfig,
        repo as unknown as SettingsRepository,
        [watchKey],
        handler,
        controller.signal,
      );

      let notificationHandler: ((msg: any) => void) | undefined;
      const { pgClient } = setupPgClientMocks(listener, (event: string, cb: any) => {
        if (event === 'notification') notificationHandler = cb;
        return pgClient;
      });

      await listener.start();
      (handler as any).mockClear();
      (repo.get as any).mockClear();

      // Notification with unwatched key
      await notificationHandler!({ payload: 'some.other.key' });

      // Should not call repo.get or handler for unwatched key
      expect(repo.get).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();

      controller.abort();
      await listener[Symbol.asyncDispose]();
    });

    it('should handle error event on pg client', async () => {
      const dbConfig = createMockDbConfig();
      const repo = createMockSettingsRepo();
      const handler: SettingChangeHandler = mock(() => {});
      const controller = new AbortController();

      const listener = new SettingsListener(
        dbConfig,
        repo as unknown as SettingsRepository,
        [SETTINGS_KEYS.developer.dockerDebugLogging],
        handler,
        controller.signal,
      );

      let errorHandler: ((err: Error) => void) | undefined;
      const { pgClient } = setupPgClientMocks(listener, (event: string, cb: any) => {
        if (event === 'error') errorHandler = cb;
        return pgClient;
      });

      await listener.start();

      // Simulate error - should not throw
      expect(errorHandler).toBeDefined();
      expect(() => errorHandler!(new Error('connection lost'))).not.toThrow();
      expect(console.error).toHaveBeenCalled();

      controller.abort();
      await listener[Symbol.asyncDispose]();
    });

    it('should swallow errors during loadInitialValues', async () => {
      const dbConfig = createMockDbConfig();
      const repo = createMockSettingsRepo();
      // Make repo.get throw
      repo.get.mockRejectedValue(new Error('DB not ready'));
      const handler: SettingChangeHandler = mock(() => {});
      const controller = new AbortController();

      const listener = new SettingsListener(
        dbConfig,
        repo as unknown as SettingsRepository,
        [SETTINGS_KEYS.developer.dockerDebugLogging],
        handler,
        controller.signal,
      );

      setupPgClientMocks(listener);

      // Should not throw despite repo error
      await expect(listener.start()).resolves.toBeUndefined();

      // Handler should not have been called since repo threw
      expect(handler).not.toHaveBeenCalled();

      controller.abort();
      await listener[Symbol.asyncDispose]();
    });
  });
});

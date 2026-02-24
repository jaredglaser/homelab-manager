import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { SettingsListener, type SettingChangeHandler } from '../settings-listener';

// Suppress console output during tests
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function createMockDbConfig() {
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
    getAll: mock(async () => new Map()),
    set: mock(async () => {}),
  } as any;
}

// We can't easily test the pg.Client integration without a real database,
// but we can test the class construction and the loadInitialValues logic
// by calling start() with a mock client.

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
      dbConfig as any,
      repo,
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
      dbConfig as any,
      repo,
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
});

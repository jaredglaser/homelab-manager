import { describe, it, expect, beforeEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { SYNTHETIC_ADMIN, type AuthUser } from '@/lib/auth/types';
import type { SettingsWireMessage } from '@/types/settings';
import { withStartContext, runRoleMiddlewareOnClientPath } from '@/lib/test/start-context';
import { mockModule } from '@/lib/test/mock-module';
import { waitForCondition } from '@/lib/test/wait-for-condition';
import type * as AuthMiddleware from '@/middleware/auth-middleware';
import type * as DatabaseMiddleware from '@/middleware/database-middleware';
import type * as DatabaseClient from '@/lib/clients/database-client';
import type * as DatabaseConfig from '@/lib/config/database-config';

let currentUser: AuthUser = SYNTHETIC_ADMIN;
const VIEWER: AuthUser = { id: 11, email: 'viewer@example.com', name: 'Viewer', role: 'viewer' };
const ADMIN: AuthUser = { id: 12, email: 'admin@example.com', name: 'Admin', role: 'admin' };

runRoleMiddlewareOnClientPath();

mockModule<typeof AuthMiddleware>('@/middleware/auth-middleware', (real) => ({
  ...real,
  authMiddleware: {
    options: {
      type: 'function',
      client: ({ next, sendContext }: { next: (opts: { sendContext: unknown }) => unknown; sendContext: unknown }) =>
        next({ sendContext: { ...(sendContext as Record<string, unknown>), user: currentUser } }),
    },
  },
}));

class ListenerClient extends EventEmitter {
  constructor(private readonly db: FakeDatabase) {
    super();
  }
  query(sql: string): Promise<{ rows: never[] }> {
    if (sql.startsWith('LISTEN ')) this.db.listeners.add(this);
    if (sql.startsWith('UNLISTEN')) this.db.listeners.delete(this);
    return Promise.resolve({ rows: [] });
  }
  release(): void {
    this.db.listeners.delete(this);
  }
}

class FakeDatabase {
  readonly userRows = new Map<string, string>();
  readonly globalRows = new Map<string, string>();
  readonly listeners = new Set<ListenerClient>();
  readonly statements: { sql: string; params: unknown[] }[] = [];

  readonly pool = {
    connect: () => Promise.resolve(new ListenerClient(this)),
    query: (sql: string, params: unknown[] = []) => {
      this.statements.push({ sql, params });
      return Promise.resolve({ rows: this.answer(sql, params) });
    },
  };

  private answer(sql: string, params: unknown[]): unknown[] {
    const [a, b, c] = params as [number | string, string, string];
    if (sql.includes('INSERT INTO user_settings')) {
      this.userRows.set(`${a}|${b}`, c);
      return [];
    }
    if (sql.includes('INSERT INTO settings')) {
      this.globalRows.set(String(a), b);
      return [];
    }
    if (sql.startsWith('SELECT pg_notify')) {
      const [channel, payload] = params as [string, string];
      for (const listener of this.listeners) listener.emit('notification', { channel, payload });
      return [];
    }
    if (sql.startsWith('SELECT key, value FROM user_settings')) {
      return [...this.userRows]
        .filter(([id]) => id.startsWith(`${a}|`))
        .map(([id, value]) => ({ key: id.slice(id.indexOf('|') + 1), value }));
    }
    if (sql.startsWith('SELECT value FROM user_settings')) {
      const value = this.userRows.get(`${a}|${b}`);
      return value === undefined ? [] : [{ value }];
    }
    throw new Error(`unexpected statement: ${sql}`);
  }
}

let db = new FakeDatabase();

mockModule<typeof DatabaseMiddleware>('@/middleware/database-middleware', (real) => ({
  ...real,
  databaseMiddleware: {
    options: {
      type: 'function',
      client: ({ next, sendContext }: { next: (opts: { sendContext: unknown }) => unknown; sendContext: unknown }) =>
        next({ sendContext: { ...(sendContext as Record<string, unknown>), pool: db.pool } }),
    },
  } as never,
}));

mockModule<typeof DatabaseClient>('@/lib/clients/database-client', (real) => ({
  ...real,
  databaseConnectionManager: { getClient: () => Promise.resolve({ getPool: () => db.pool }) } as never,
}));
mockModule<typeof DatabaseConfig>('@/lib/config/database-config', (real) => ({
  ...real,
  loadDatabaseConfig: () => ({}) as ReturnType<typeof DatabaseConfig.loadDatabaseConfig>,
}));

const { updateSetting, updateUserSetting } = await import('@/data/settings/functions');
const { SettingsBroadcastService } = await import('@/lib/settings/settings-broadcast-service');
const { USER_SETTINGS_CHANNEL, UserSettingsRepository, parseUserSettingsNotifyPayload } = await import(
  '@/lib/database/repositories/settings-repository'
);

function as(user: AuthUser) {
  currentUser = user;
}

async function save(user: AuthUser, key: string, value: string): Promise<void> {
  as(user);
  await withStartContext(() => updateUserSetting({ data: { key: key as 'general/use12HourTime', value } }));
}

function openClient(user: AuthUser) {
  const service = new SettingsBroadcastService<number>({
    getPoolClient: () => db.pool.connect() as never,
    channel: USER_SETTINGS_CHANNEL,
    parseNotification: parseUserSettingsNotifyPayload,
    loadAllSettings: (userId) => new UserSettingsRepository(db.pool as never).getAll(userId),
    loadSingleSetting: (key, userId) => new UserSettingsRepository(db.pool as never).get(userId, key),
  });
  const frames: SettingsWireMessage[] = [];
  const unsubscribe = service.subscribe((message) => frames.push(message), user.id);
  return { frames, close: unsubscribe, service };
}

beforeEach(() => {
  db = new FakeDatabase();
  as(SYNTHETIC_ADMIN);
});

describe('updateUserSetting', () => {
  it("stores a change for the signed-in user only, and a fresh client of that user reads it back", async () => {
    await save(ADMIN, 'general/use12HourTime', 'true');
    await save(VIEWER, 'general/use12HourTime', 'false');
    await save(VIEWER, 'docker/chartWindowSeconds', '900');

    const repo = new UserSettingsRepository(db.pool as never);
    expect(Object.fromEntries(await repo.getAll(ADMIN.id))).toEqual({ 'general/use12HourTime': 'true' });

    const fresh = openClient(VIEWER);
    await waitForCondition(() => fresh.frames.length > 0);
    expect(fresh.frames[0]).toEqual({
      type: 'init',
      settings: { 'general/use12HourTime': 'false', 'docker/chartWindowSeconds': '900' },
    });
    fresh.close();
    expect(db.globalRows.size).toBe(0);
  });

  it.each(['viewer', 'operator', 'admin'] as const)('lets a %s save their own display settings', async (role) => {
    const user: AuthUser = { id: 30, email: `${role}@example.com`, name: role, role };
    await save(user, 'general/lightPalette', 'dusty-rose');
    expect(db.userRows.get('30|general/lightPalette')).toBe('dusty-rose');
  });

  it('saves, persists and syncs the AUTH_DISABLED synthetic admin as user 0', async () => {
    const other = openClient(SYNTHETIC_ADMIN);
    await waitForCondition(() => other.frames.length > 0 && db.listeners.size > 0);

    await save(SYNTHETIC_ADMIN, 'zfs/decimals/diskSpeed', 'true');
    await waitForCondition(() => other.frames.length > 1);

    expect(db.userRows.get(`${SYNTHETIC_ADMIN.id}|zfs/decimals/diskSpeed`)).toBe('true');
    expect(other.frames[1]).toEqual({ type: 'change', key: 'zfs/decimals/diskSpeed', value: 'true' });
    other.close();
  });

  it("pushes a change to the user's other open clients and never to another user's", async () => {
    const viewerTab = openClient(VIEWER);
    const viewerPhone = openClient(VIEWER);
    const admin = openClient(ADMIN);
    await waitForCondition(() => [viewerTab, viewerPhone, admin].every((c) => c.frames.length > 0) && db.listeners.size === 3);

    await save(VIEWER, 'general/showSparklines', 'false');
    await waitForCondition(() => viewerTab.frames.length > 1 && viewerPhone.frames.length > 1);

    const change: SettingsWireMessage = { type: 'change', key: 'general/showSparklines', value: 'false' };
    expect(viewerTab.frames[1]).toEqual(change);
    expect(viewerPhone.frames[1]).toEqual(change);
    expect(admin.frames).toEqual([{ type: 'init', settings: {} }]);
    for (const client of [viewerTab, viewerPhone, admin]) client.close();
  });

  // A direct call skips the validator (schemas.test.ts pins that it rejects these bodies), so this proves the handler ignores them.
  it.each([
    ['userId', ADMIN.id],
    ['user_id', ADMIN.id],
    ['user', { id: ADMIN.id }],
  ])('never stores under a user the request names through %s', async (field, value) => {
    as(VIEWER);
    const data = { key: 'general/use12HourTime', value: 'true', [field]: value } as never;
    await withStartContext(() => updateUserSetting({ data }));
    expect([...db.userRows.keys()]).toEqual([`${VIEWER.id}|general/use12HourTime`]);
  });
});

describe('updateSetting', () => {
  it.each(['general/updateIntervalMs', 'proxmox/updateInterval', 'developer/dockerDebugLogging', 'developer/dbFlushDebugLogging'] as const)(
    'keeps %s global and closed to a viewer',
    async (key) => {
      as(VIEWER);
      const refused = await withStartContext(() => updateSetting({ data: { key, value: '1' } })).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).message).toBe('Insufficient permissions');
      as(ADMIN);
      await withStartContext(() => updateSetting({ data: { key, value: '1' } }));
      expect(db.globalRows.get(key)).toBe('1');
    },
  );
});

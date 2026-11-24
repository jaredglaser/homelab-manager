import { describe, it, expect } from 'bun:test';
import type { AuthUser } from '@/lib/auth/types';
import { withStartContext } from '@/lib/test/start-context';
import { mockModule } from '@/lib/test/mock-module';
import type * as ResolveUser from '@/lib/auth/resolve-user';
import type * as DatabaseClient from '@/lib/clients/database-client';
import type * as DatabaseConfig from '@/lib/config/database-config';
import type * as StartServerCore from '@tanstack/start-server-core';

const VIEWER: AuthUser = { id: 11, email: 'viewer@example.com', name: 'Viewer', role: 'viewer' };
const ADMIN: AuthUser = { id: 12, email: 'admin@example.com', name: 'Admin', role: 'admin' };

const writes: unknown[][] = [];
const pool = {
  query: (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO user_settings')) writes.push(params);
    return Promise.resolve({ rows: [] });
  },
};

mockModule<typeof StartServerCore>('@tanstack/start-server-core', (real) => ({
  ...real,
  getRequest: () => new Request('http://localhost/_serverFn/x', { headers: { cookie: 'session=viewer' } }),
}));
mockModule<typeof ResolveUser>('@/lib/auth/resolve-user', (real) => ({
  ...real,
  resolveUserFromCookie: () => Promise.resolve(VIEWER),
}));
mockModule<typeof DatabaseClient>('@/lib/clients/database-client', (real) => ({
  ...real,
  databaseConnectionManager: { getClient: () => Promise.resolve({ getPool: () => pool }) },
}));
mockModule<typeof DatabaseConfig>('@/lib/config/database-config', (real) => ({
  ...real,
  loadDatabaseConfig: () => ({}) as ReturnType<typeof DatabaseConfig.loadDatabaseConfig>,
}));

const { executeMiddleware } = await import('@tanstack/start-client-core');
const { authMiddleware } = await import('@/middleware/auth-middleware');
const { roleMiddleware } = await import('@/lib/auth/role-middleware');
const { databaseMiddleware } = await import('@/middleware/database-middleware');
const { updateUserSettingSchema } = await import('@/data/settings/schemas');
const { UserSettingsRepository } = await import('@/lib/database/repositories/settings-repository');

interface HandlerContext {
  user: AuthUser;
  pool: never;
}

// Under Happy-DOM without the Start compiler createServerFn has no server path, so this copies updateUserSetting's chain.
const handler = {
  options: {
    validator: updateUserSettingSchema,
    server: async ({ context, data }: { context: HandlerContext; data: { key: string; value: string } }) => {
      await new UserSettingsRepository(context.pool).set(context.user.id, data.key, data.value);
      return { context, data, result: undefined };
    },
  },
};

describe('updateUserSetting middleware chain on the server', () => {
  it('writes under the session user when the client-sent context names another user', async () => {
    const result = await withStartContext(() =>
      executeMiddleware(
        [authMiddleware, roleMiddleware('admin', 'operator', 'viewer'), databaseMiddleware, handler] as never,
        'server',
        { data: { key: 'general/use12HourTime', value: 'false' }, context: { user: ADMIN } } as never,
      ),
    );

    expect((result as { error?: unknown }).error).toBeUndefined();
    expect(writes).toEqual([[VIEWER.id, 'general/use12HourTime', 'false']]);
  });

  it('refuses a body that names another user before anything is written', async () => {
    writes.length = 0;
    const result = await withStartContext(() =>
      executeMiddleware(
        [authMiddleware, roleMiddleware('admin', 'operator', 'viewer'), databaseMiddleware, handler] as never,
        'server',
        { data: { key: 'general/use12HourTime', value: 'false', userId: ADMIN.id }, context: {} } as never,
      ),
    );

    expect((result as { error?: unknown }).error).toBeInstanceOf(Error);
    expect(writes).toEqual([]);
  });
});

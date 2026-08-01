import { createServerFn } from '@tanstack/react-start';
import { databaseMiddleware } from '@/middleware/database-middleware';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';
import { updateSettingSchema, setViewStateSchema } from '@/data/settings/schemas';
import { VIEW_STATE_KEYS } from '@/lib/constants/settings-keys';

export const updateSetting = createServerFn()
  .middleware([authMiddleware, databaseMiddleware])
  .inputValidator(updateSettingSchema)
  .handler(async ({ context, data }): Promise<void> => {
    requireRole('admin', 'operator')(context.user);
    const { SettingsRepository } = await import(
      '@/lib/database/repositories/settings-repository'
    );
    const repo = new SettingsRepository(context.pool);
    await repo.set(data.key, data.value);
  });

export const getViewState = createServerFn()
  .middleware([authMiddleware, databaseMiddleware])
  .handler(async ({ context }): Promise<Record<string, string>> => {
    requireRole('admin', 'operator', 'viewer')(context.user);
    const { SettingsRepository } = await import(
      '@/lib/database/repositories/settings-repository'
    );
    const repo = new SettingsRepository(context.pool);
    return Object.fromEntries(await repo.getMany(VIEW_STATE_KEYS));
  });

export const setViewState = createServerFn()
  .middleware([authMiddleware, databaseMiddleware])
  .inputValidator(setViewStateSchema)
  .handler(async ({ context, data }): Promise<void> => {
    requireRole('admin', 'operator', 'viewer')(context.user);
    const { SettingsRepository } = await import(
      '@/lib/database/repositories/settings-repository'
    );
    const repo = new SettingsRepository(context.pool);
    await repo.set(data.key, data.value);
  });

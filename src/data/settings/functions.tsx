import { createServerFn } from '@tanstack/react-start';
import { databaseMiddleware } from '@/middleware/database-middleware';
import { authMiddleware } from '@/middleware/auth-middleware';
import { roleMiddleware } from '@/lib/auth/role-middleware';
import { updateSettingSchema, updateUserSettingSchema } from '@/data/settings/schemas';

export const updateSetting = createServerFn()
  .middleware([authMiddleware, roleMiddleware('admin', 'operator'), databaseMiddleware])
  .validator(updateSettingSchema)
  .handler(async ({ context, data }): Promise<void> => {
    const { SettingsRepository } = await import(
      '@/lib/database/repositories/settings-repository'
    );
    const repo = new SettingsRepository(context.pool);
    await repo.set(data.key, data.value);
  });

export const updateUserSetting = createServerFn({ method: 'POST' })
  .middleware([authMiddleware, roleMiddleware('admin', 'operator', 'viewer'), databaseMiddleware])
  .validator(updateUserSettingSchema)
  .handler(async ({ context, data }): Promise<void> => {
    const { UserSettingsRepository } = await import(
      '@/lib/database/repositories/settings-repository'
    );
    const repo = new UserSettingsRepository(context.pool);
    await repo.set(context.user.id, data.key, data.value);
  });

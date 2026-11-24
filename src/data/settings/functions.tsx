import { createServerFn } from '@tanstack/react-start';
import { databaseMiddleware } from '@/middleware/database-middleware';
import { authMiddleware } from '@/middleware/auth-middleware';
import { roleMiddleware } from '@/lib/auth/role-middleware';
import { updateSettingSchema } from '@/data/settings/schemas';

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

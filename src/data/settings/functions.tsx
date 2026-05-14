import { createServerFn } from '@tanstack/react-start';
import { databaseMiddleware } from '@/middleware/database-middleware';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';
import { updateSettingSchema } from '@/data/settings/schemas';

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

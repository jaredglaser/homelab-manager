import { createServerFn } from '@tanstack/react-start';
import { databaseMiddleware } from '@/middleware/database-middleware';
import { updateSettingSchema } from '@/data/settings/schemas';

export const updateSetting = createServerFn()
  .middleware([databaseMiddleware])
  .inputValidator(updateSettingSchema)
  .handler(async ({ context, data }): Promise<void> => {
    const { SettingsRepository } = await import(
      '@/lib/database/repositories/settings-repository'
    );
    const repo = new SettingsRepository(context.pool);
    await repo.set(data.key, data.value);
  });

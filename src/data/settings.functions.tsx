import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';

async function getSettingsRepository() {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { SettingsRepository } = await import(
    '@/lib/database/repositories/settings-repository'
  );

  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  return new SettingsRepository(client.getPool());
}

const updateSettingSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

export const updateSetting = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(updateSettingSchema)
  .handler(async ({ data, context }): Promise<void> => {
    requireRole('admin', 'operator')(context.user);
    const repo = await getSettingsRepository();
    await repo.set(data.key, data.value);
  });

import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

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

export const getAllSettings = createServerFn()
  .handler(async (): Promise<Record<string, string>> => {
    const repo = await getSettingsRepository();
    const settings = await repo.getAll();
    return Object.fromEntries(settings);
  });

const updateSettingSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

export const updateSetting = createServerFn()
  .inputValidator(updateSettingSchema)
  .handler(async ({ data }): Promise<void> => {
    const repo = await getSettingsRepository();
    await repo.set(data.key, data.value);
  });

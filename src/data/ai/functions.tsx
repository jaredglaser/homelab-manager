import { createServerFn } from '@tanstack/react-start';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';
import type { AiAnalysisSnapshot } from '@/types/ai';
import type { ProbeResult } from '@/lib/ai/provider';
import {
  handleGetAiConfig,
  handleGetAiSnapshot,
  handleSaveAiProvider,
  handleSaveAiSettings,
  handleSetAlertStatus,
  handleSetContainerAnalysis,
  handleTestAiEndpoint,
  type AiConfigView,
  type AiHandlerDeps,
} from '@/data/ai/handlers';
import {
  saveAiProviderSchema,
  saveAiSettingsSchema,
  setAlertStatusSchema,
  setContainerAnalysisSchema,
  testAiEndpointSchema,
} from '@/data/ai/schemas';

export type { AiConfigView } from '@/data/ai/handlers';

async function loadDeps(): Promise<AiHandlerDeps> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
  const { AiProviderRepository } = await import('@/lib/database/repositories/ai-provider-repository');
  const { AiAnalysisRepository } = await import('@/lib/database/repositories/ai-analysis-repository');
  const { SettingsRepository } = await import('@/lib/database/repositories/settings-repository');

  const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
  const pool = dbClient.getPool();
  return {
    provider: new AiProviderRepository(pool, await loadMasterKeyring()),
    analysis: new AiAnalysisRepository(pool),
    settings: new SettingsRepository(pool),
  };
}

export const getAiConfig = createServerFn()
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<AiConfigView> => {
    requireRole('admin')(context.user);
    return handleGetAiConfig(await loadDeps());
  });

export const saveAiProvider = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(saveAiProviderSchema)
  .handler(async ({ data, context }): Promise<AiConfigView> => {
    requireRole('admin')(context.user);
    return handleSaveAiProvider(await loadDeps(), data);
  });

export const saveAiSettings = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(saveAiSettingsSchema)
  .handler(async ({ data, context }): Promise<AiConfigView> => {
    requireRole('admin')(context.user);
    return handleSaveAiSettings(await loadDeps(), data);
  });

export const testAiEndpoint = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(testAiEndpointSchema)
  .handler(async ({ data, context }): Promise<ProbeResult> => {
    requireRole('admin')(context.user);
    return handleTestAiEndpoint(await loadDeps(), data);
  });

export const setContainerAnalysis = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(setContainerAnalysisSchema)
  .handler(async ({ data, context }): Promise<{ success: true }> => {
    requireRole('operator')(context.user);
    return handleSetContainerAnalysis(await loadDeps(), data);
  });

export const setAlertStatus = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(setAlertStatusSchema)
  .handler(async ({ data, context }): Promise<{ success: true }> => {
    requireRole('operator')(context.user);
    return handleSetAlertStatus(await loadDeps(), data);
  });

export const getAiSnapshot = createServerFn()
  .middleware([authMiddleware])
  .handler(async (): Promise<AiAnalysisSnapshot> => {
    return handleGetAiSnapshot(await loadDeps());
  });

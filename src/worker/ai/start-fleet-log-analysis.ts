import type { Pool } from 'pg';
import type { DatabaseClient } from '@/lib/clients/database-client';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { AiAnalysisRepository } from '@/lib/database/repositories/ai-analysis-repository';
import { AiProviderRepository, type AiProviderRow } from '@/lib/database/repositories/ai-provider-repository';
import { DockerContainerEventRepository } from '@/lib/database/repositories/docker-container-event-repository';
import { HostRepository } from '@/lib/database/repositories/host-repository';
import { SettingsRepository } from '@/lib/database/repositories/settings-repository';
import { resolveAiSettings, type AiRuntimeSettings } from '@/lib/ai/config';
import { buildModels } from '@/lib/ai/provider';
import { Semaphore } from '@/lib/ai/semaphore';
import { abortableSleep } from '@/lib/utils/abortable-sleep';
import { FleetLogAnalysisManager } from '@/worker/ai/fleet-log-analysis-manager';
import { runObservationTriageLoop } from '@/worker/ai/observation-triage-loop';

/** How often the analyst set is reconciled against the container inventory. */
const RECONCILE_INTERVAL_MS = 60_000;

export interface StartFleetLogAnalysisDeps {
  db: DatabaseClient;
  getSigner: (hostName: string) => Promise<(() => Promise<string>) | null>;
  signal: AbortSignal;
  reconcileIntervalMs?: number;
  triageIntervalMs?: number;
  /** Injected so the composition root is testable without a master key or an endpoint. */
  loadSettings?: (pool: Pool) => Promise<AiRuntimeSettings>;
  loadProvider?: (pool: Pool) => Promise<AiProviderRow | null>;
}

export interface FleetLogAnalysisHandle {
  manager: FleetLogAnalysisManager;
  runners: Promise<void>[];
}

async function defaultLoadSettings(pool: Pool): Promise<AiRuntimeSettings> {
  const repo = new SettingsRepository(pool);
  const keys = Object.values(SETTINGS_KEYS.ai);
  const entries = await Promise.all(keys.map(async (key) => [key, await repo.get(key)] as const));
  return resolveAiSettings(Object.fromEntries(entries));
}

async function defaultLoadProvider(pool: Pool): Promise<AiProviderRow | null> {
  const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
  return new AiProviderRepository(pool, await loadMasterKeyring()).getWithKey();
}

/**
 * Composition root for AI log analysis in the worker.
 *
 * Returns null when the feature is switched off or no endpoint is configured,
 * which is the common case: the rest of the worker must start regardless.
 * Settings are read once at startup; toggling the feature takes a worker
 * restart, which the POC accepts rather than tearing agents down mid-day.
 */
export async function startFleetLogAnalysis(
  deps: StartFleetLogAnalysisDeps,
): Promise<FleetLogAnalysisHandle | null> {
  const pool = deps.db.getPool();
  const settings = await (deps.loadSettings ?? defaultLoadSettings)(pool);
  if (!settings.enabled) return null;

  const provider = await (deps.loadProvider ?? defaultLoadProvider)(pool);
  if (!provider) {
    console.info('[FleetLogAnalysis] Enabled but no endpoint configured; skipping');
    return null;
  }

  const models = buildModels({
    baseUrl: provider.baseUrl,
    model: provider.model,
    profilerModel: provider.profilerModel,
    apiKey: provider.apiKey,
    maxContextTokens: provider.maxContextTokens,
  });

  const repo = new AiAnalysisRepository(pool);
  const inventoryRepo = new DockerContainerEventRepository(pool);
  const hostRepo = new HostRepository(pool);
  const semaphore = new Semaphore(settings.maxConcurrentAgents);

  const manager = new FleetLogAnalysisManager({
    repo,
    models,
    settings,
    semaphore,
    signal: deps.signal,
    loadSnapshot: () => inventoryRepo.getCurrentSnapshot(),
    loadHosts: () => hostRepo.findAll(),
    getSigner: deps.getSigner,
  });

  console.info(
    `[FleetLogAnalysis] Enabled against ${provider.baseUrl} (analyst=${models.analystModelId},` +
      ` profiler=${models.profilerModelId}, concurrency=${settings.maxConcurrentAgents})`,
  );

  await manager.reconcile();

  const reconcileIntervalMs = deps.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS;
  const reconcileLoop = (async () => {
    while (!deps.signal.aborted) {
      try {
        await abortableSleep(reconcileIntervalMs, deps.signal);
      } catch {
        return;
      }
      if (deps.signal.aborted) return;
      await manager.reconcile();
    }
  })();

  const triageLoop = runObservationTriageLoop({
    repo,
    models,
    settings,
    semaphore,
    signal: deps.signal,
    intervalMs: deps.triageIntervalMs,
  });

  return { manager, runners: [reconcileLoop, triageLoop] };
}

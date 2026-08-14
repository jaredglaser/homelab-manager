import type { AiAnalysisRepository } from '@/lib/database/repositories/ai-analysis-repository';
import type { AiObservation } from '@/types/ai';
import { severityAtLeast, type AiRuntimeSettings } from '@/lib/ai/config';
import type { AiModelSet } from '@/lib/ai/provider';
import type { Semaphore } from '@/lib/ai/semaphore';
import { triageObservations, type RaisedAlert } from '@/lib/ai/triage-agent';
import { abortableSleep, isAbortError } from '@/lib/utils/abortable-sleep';

const DEFAULT_INTERVAL_MS = 120_000;
const MAX_PER_PASS = 25;

export interface ObservationTriageLoopDeps {
  repo: AiAnalysisRepository;
  models: AiModelSet;
  settings: AiRuntimeSettings;
  semaphore: Semaphore;
  signal: AbortSignal;
  intervalMs?: number;
  /** Injected so tests can drive triage without an endpoint. */
  triage?: typeof triageObservations;
}

/**
 * Decides which observations the orchestrator even looks at.
 *
 * Anything at or above the operator's alert floor is worth a pass on its own.
 * Below the floor, a single line is noise, but a burst across the fleet in one
 * window is exactly the cross-container pattern the orchestrator exists to
 * catch, so the whole claimed set goes in once at least one item clears the
 * floor or the low-severity volume is itself unusual.
 */
export function shouldTriage(observations: AiObservation[], settings: AiRuntimeSettings): boolean {
  if (observations.length === 0) return false;
  if (observations.some((observation) => severityAtLeast(observation.severity, settings.alertSeverity))) {
    return true;
  }
  const distinctEntities = new Set(observations.map((o) => `${o.host}/${o.containerKey}`));
  return distinctEntities.size >= 3;
}

export async function runTriagePass(deps: ObservationTriageLoopDeps): Promise<RaisedAlert[]> {
  const observations = await deps.repo.claimUntriaged(MAX_PER_PASS);
  if (!shouldTriage(observations, deps.settings)) return [];

  const triage = deps.triage ?? triageObservations;
  const alerts = await deps.semaphore.run(() =>
    triage({
      observations,
      alertFloor: deps.settings.alertSeverity,
      model: deps.models.analyst,
      abortSignal: deps.signal,
    }),
  );

  for (const alert of alerts) {
    await deps.repo.addAlert(alert);
    console.info(`[FleetTriage] Raised ${alert.severity} alert: ${alert.title}`);
  }
  return alerts;
}

/**
 * Polls for observations the container analysts have filed and runs the
 * orchestrator over them. Runs until the signal aborts; a failed pass is logged
 * and the loop continues, since the observations it claimed are already durable.
 */
export async function runObservationTriageLoop(deps: ObservationTriageLoopDeps): Promise<void> {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  while (!deps.signal.aborted) {
    try {
      await abortableSleep(intervalMs, deps.signal);
    } catch {
      return;
    }
    if (deps.signal.aborted) return;

    try {
      await runTriagePass(deps);
    } catch (err) {
      if (isAbortError(err)) return;
      console.error('[FleetTriage] Pass failed:', err instanceof Error ? err.message : err);
    }
  }
}

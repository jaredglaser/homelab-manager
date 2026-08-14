import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { AI_SEVERITIES, type AiSeverity } from '@/types/ai';

export interface AiRuntimeSettings {
  enabled: boolean;
  /** Log lines accumulated before an analysis turn is triggered. */
  batchLines: number;
  /** Ceiling on container agents running a model call at the same time. */
  maxConcurrentAgents: number;
  /** How far back the profiler samples when authoring a new container's skill. */
  profileWindowDays: number;
  /** Lowest observation severity the orchestrator will escalate into an alert. */
  alertSeverity: AiSeverity;
}

export const AI_DEFAULTS: AiRuntimeSettings = {
  enabled: false,
  batchLines: 200,
  maxConcurrentAgents: 3,
  profileWindowDays: 7,
  alertSeverity: 'warning',
};

const RANGES = {
  batchLines: { min: 20, max: 2000 },
  maxConcurrentAgents: { min: 1, max: 32 },
  profileWindowDays: { min: 1, max: 30 },
} as const;

function readInt(
  raw: string | null | undefined,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (raw === null || raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(range.max, Math.max(range.min, parsed));
}

function readSeverity(raw: string | null | undefined, fallback: AiSeverity): AiSeverity {
  return AI_SEVERITIES.includes(raw as AiSeverity) ? (raw as AiSeverity) : fallback;
}

/** Reads the runtime knobs out of a plain settings map, clamping out-of-range values. */
export function resolveAiSettings(settings: Record<string, string | null>): AiRuntimeSettings {
  return {
    enabled: settings[SETTINGS_KEYS.ai.enabled] === 'true',
    batchLines: readInt(settings[SETTINGS_KEYS.ai.batchLines], AI_DEFAULTS.batchLines, RANGES.batchLines),
    maxConcurrentAgents: readInt(
      settings[SETTINGS_KEYS.ai.maxConcurrentAgents],
      AI_DEFAULTS.maxConcurrentAgents,
      RANGES.maxConcurrentAgents,
    ),
    profileWindowDays: readInt(
      settings[SETTINGS_KEYS.ai.profileWindowDays],
      AI_DEFAULTS.profileWindowDays,
      RANGES.profileWindowDays,
    ),
    alertSeverity: readSeverity(settings[SETTINGS_KEYS.ai.alertSeverity], AI_DEFAULTS.alertSeverity),
  };
}

const SEVERITY_RANK: Record<AiSeverity, number> = {
  info: 0,
  notice: 1,
  warning: 2,
  critical: 3,
};

export function severityAtLeast(severity: AiSeverity, floor: AiSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[floor];
}

/** Highest of a set, used when an alert folds several observations together. */
export function maxSeverity(severities: AiSeverity[]): AiSeverity {
  return severities.reduce<AiSeverity>(
    (worst, next) => (SEVERITY_RANK[next] > SEVERITY_RANK[worst] ? next : worst),
    'info',
  );
}

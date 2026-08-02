import type {
  AnsibleHostOutcome,
  AnsibleHostSummary,
  AnsibleRunEvent,
  AnsibleRunStatus,
} from '@/types/ansible';

/**
 * Runner event names carry no host or task fields of their own; everything comes out
 * of `event_data`. Only the keys listed here are ever read, so a module return value
 * or a future runner field cannot reach the database or the browser by default.
 */
interface RawRunnerEvent {
  event?: unknown;
  counter?: unknown;
  status?: unknown;
  event_data?: Record<string, unknown>;
}

const HOST_RESULT_OUTCOMES: Record<string, AnsibleHostOutcome | 'skipped'> = {
  runner_on_ok: 'ok',
  runner_on_failed: 'failed',
  runner_on_unreachable: 'unreachable',
  runner_on_skipped: 'skipped',
};

const RUNNER_STATUS_MAP: Record<string, AnsibleRunStatus> = {
  starting: 'running',
  running: 'running',
  successful: 'succeeded',
  failed: 'failed',
  timeout: 'failed',
  canceled: 'cancelled',
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function counterOf(raw: RawRunnerEvent): number {
  return typeof raw.counter === 'number' && Number.isFinite(raw.counter) ? raw.counter : 0;
}

/** `event_data`'s stats maps are `{ host: count }`; a host absent from a map scored zero. */
function countsFor(map: unknown, host: string): number {
  if (typeof map !== 'object' || map === null) return 0;
  const value = (map as Record<string, unknown>)[host];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function outcomeFor(failures: number, unreachable: number, changed: number): AnsibleHostOutcome {
  if (unreachable > 0) return 'unreachable';
  if (failures > 0) return 'failed';
  return changed > 0 ? 'changed' : 'ok';
}

export function summarizeStats(eventData: Record<string, unknown>): AnsibleHostSummary[] {
  const maps = ['ok', 'changed', 'failures', 'dark', 'skipped', 'processed'] as const;
  const hosts = new Set<string>();
  for (const key of maps) {
    const map = eventData[key];
    if (typeof map === 'object' && map !== null) {
      for (const host of Object.keys(map)) hosts.add(host);
    }
  }

  return Array.from(hosts)
    .sort()
    .map((host) => {
      const failures = countsFor(eventData.failures, host);
      const unreachable = countsFor(eventData.dark, host);
      const changed = countsFor(eventData.changed, host);
      return {
        host,
        ok: countsFor(eventData.ok, host),
        changed,
        failures,
        unreachable,
        skipped: countsFor(eventData.skipped, host),
        outcome: outcomeFor(failures, unreachable, changed),
      };
    });
}

/** Returns `null` for the runner events this UI has no use for (verbose, warnings, per-item results). */
export function normalizeRunnerEvent(raw: unknown): AnsibleRunEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const event = raw as RawRunnerEvent;
  const name = str(event.event);
  if (name === null) return null;

  const counter = counterOf(event);
  const data = event.event_data ?? {};

  if (name === 'runner_status') {
    const status = RUNNER_STATUS_MAP[str(event.status) ?? ''];
    return status ? { kind: 'status', counter, status } : null;
  }

  if (name === 'playbook_on_play_start') {
    return { kind: 'play_start', counter, play: str(data.play) ?? 'play' };
  }

  if (name === 'playbook_on_task_start') {
    return {
      kind: 'task_start',
      counter,
      task: str(data.task) ?? 'task',
      action: str(data.task_action),
    };
  }

  if (name === 'playbook_on_stats') {
    return { kind: 'stats', counter, summaries: summarizeStats(data) };
  }

  const outcome = HOST_RESULT_OUTCOMES[name];
  const host = str(data.host);
  if (outcome && host) {
    return { kind: 'host_result', counter, host, task: str(data.task), outcome };
  }

  return null;
}

/**
 * Terminal status for a run whose stream ended without a `runner_status` frame saying so.
 * A host that was never reached is not a failed run on its own, which is what keeps one
 * sleeping host from turning every run red.
 */
export function statusFromSummaries(summaries: AnsibleHostSummary[]): AnsibleRunStatus {
  if (summaries.length === 0) return 'failed';
  return summaries.some((s) => s.outcome === 'failed') ? 'failed' : 'succeeded';
}

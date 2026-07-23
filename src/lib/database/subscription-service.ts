import { databaseConnectionManager } from '@/lib/clients/database-client';
import { loadDatabaseConfig } from '@/lib/config/database-config';
import { StatsRepository } from '@/lib/database/repositories/stats-repository';
import { backoffDelayMs } from '@/lib/utils/backoff';

export type StatsSource = 'docker' | 'zfs' | 'proxmox';
/** Minimal shape the poll loop needs; docker/zfs/proxmox rows all satisfy this. */
interface StatsRow {
  time: string | Date;
}
type StatsCallback = (rows: unknown[]) => void;
type StatsErrorCallback = () => void;
type LoadRowsFn = (source: StatsSource, since: Date) => Promise<StatsRow[]>;

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 5000;
const FAILURE_THRESHOLD = 3;
// Failures double the effective spacing (2s, 4s, 8s, capped at 10s) until a poll succeeds.
const MAX_BACKOFF_MS = 10_000;

/** Rebuilds the repo per call (not cached) so a DatabaseConnectionManager reconnect is picked up next tick. */
async function defaultLoadRows(source: StatsSource, since: Date): Promise<StatsRow[]> {
  const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
  const repo = new StatsRepository(dbClient.getPool());
  switch (source) {
    case 'docker':
      return repo.getDockerStatsSince(since);
    case 'zfs':
      return repo.getZFSStatsSince(since);
    case 'proxmox':
      return repo.getProxmoxStatsSince(since);
  }
}

export interface StatsPollServiceDeps {
  loadRows?: LoadRowsFn;
}

/**
 * Shared poll service: one setInterval per source (docker, zfs), broadcasting to subscribed SSE clients.
 * Auto-starts on first subscriber per source, auto-stops when the last leaves.
 */
export class StatsPollService {
  private subscribers = new Map<StatsSource, Set<StatsCallback>>();
  private errorCallbacks = new Map<StatsSource, Set<StatsErrorCallback>>();
  private intervals = new Map<StatsSource, ReturnType<typeof setInterval>>();
  private lastPollTime = new Map<StatsSource, Date>();
  private consecutiveFailures = new Map<StatsSource, number>();
  private skipTicks = new Map<StatsSource, number>();
  private errorSignalled = new Set<StatsSource>();
  private stoppedSources = new Set<StatsSource>();
  // Sources with a poll still in flight, so a run of slow polls can't stack concurrent queries.
  private inFlight = new Set<StatsSource>();
  private readonly loadRows: LoadRowsFn;

  constructor(deps: StatsPollServiceDeps = {}) {
    this.loadRows = deps.loadRows ?? defaultLoadRows;
  }

  subscribe(source: StatsSource, callback: StatsCallback, onError?: StatsErrorCallback): () => void {
    let subs = this.subscribers.get(source);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(source, subs);
    }
    subs.add(callback);

    if (onError) {
      let errCbs = this.errorCallbacks.get(source);
      if (!errCbs) {
        errCbs = new Set();
        this.errorCallbacks.set(source, errCbs);
      }
      errCbs.add(onError);
    }

    if (subs.size === 1) {
      this.startPolling(source);
    }

    return () => {
      subs!.delete(callback);
      if (onError) this.errorCallbacks.get(source)?.delete(onError);
      if (subs!.size === 0) {
        this.stopPolling(source);
        this.subscribers.delete(source);
      }
    };
  }

  private startPolling(source: StatsSource): void {
    this.stoppedSources.delete(source);
    this.lastPollTime.set(source, new Date());

    const intervalId = setInterval(async () => {
      const subs = this.subscribers.get(source);
      if (!subs || subs.size === 0) return;

      const pendingSkips = this.skipTicks.get(source) ?? 0;
      if (pendingSkips > 0) {
        this.skipTicks.set(source, pendingSkips - 1);
        return;
      }

      if (this.inFlight.has(source)) return;
      this.inFlight.add(source);

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const last = this.lastPollTime.get(source) ?? new Date();
        const since = new Date(last.getTime() - 200); // 200ms lookback for late-committing rows

        const rowsPromise = this.loadRows(source, since);

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Poll timeout')), POLL_TIMEOUT_MS);
        });

        const rows = await Promise.race([rowsPromise, timeoutPromise]);

        this.consecutiveFailures.set(source, 0);
        this.skipTicks.delete(source);
        this.errorSignalled.delete(source);

        // Only rows newer than the last poll: avoids rebroadcasting stale data (breaks the frontend's 30s stale detection).
        const toMs = (value: string | Date) => new Date(value).getTime();
        const newRows = rows.filter(r => toMs(r.time) > last.getTime());

        if (newRows.length > 0) {
          // Cursor advances to the max row time seen, not wall-clock, so late-committing rows aren't skipped.
          const maxSeenTime = rows.reduce(
            (max, r) => Math.max(max, toMs(r.time)),
            last.getTime()
          );
          this.lastPollTime.set(source, new Date(maxSeenTime));
          for (const cb of subs) {
            cb(rows); // includes the 200ms overlap; frontend Map deduplicates
          }
        }
      } catch (err) {
        console.error(`[StatsPollService] Poll failed for source "${source}":`, err);
        const failures = (this.consecutiveFailures.get(source) ?? 0) + 1;
        this.consecutiveFailures.set(source, failures);

        const backoffMs = backoffDelayMs(failures, { baseMs: POLL_INTERVAL_MS, capMs: MAX_BACKOFF_MS });
        // -1: the current (failing) tick already consumed one interval.
        this.skipTicks.set(source, backoffMs / POLL_INTERVAL_MS - 1);

        if (failures >= FAILURE_THRESHOLD && !this.errorSignalled.has(source)) {
          this.errorSignalled.add(source);
          const errCbs = this.errorCallbacks.get(source);
          if (errCbs) {
            for (const cb of errCbs) cb();
          }
        }
      } finally {
        // Clears the race's other timer so it doesn't leak past a successful poll.
        clearTimeout(timeoutId);
        this.inFlight.delete(source);
      }
    }, POLL_INTERVAL_MS);

    this.intervals.set(source, intervalId);
  }

  private stopPolling(source: StatsSource): void {
    this.stoppedSources.add(source);
    const intervalId = this.intervals.get(source);
    if (intervalId) {
      clearInterval(intervalId);
      this.intervals.delete(source);
    }
    this.lastPollTime.delete(source);
    this.consecutiveFailures.delete(source);
    this.skipTicks.delete(source);
    this.errorSignalled.delete(source);
    this.errorCallbacks.delete(source);
    this.inFlight.delete(source);
  }

  async stop(): Promise<void> {
    for (const source of this.intervals.keys()) {
      this.stopPolling(source);
    }
    this.subscribers.clear();
  }
}

export const statsPollService = new StatsPollService();

import { databaseConnectionManager } from '@/lib/clients/database-client';
import { loadDatabaseConfig } from '@/lib/config/database-config';
import { StatsRepository } from '@/lib/database/repositories/stats-repository';
import { backoffDelayMs } from '@/lib/utils/backoff';

export type StatsSource = 'docker' | 'zfs' | 'proxmox';
type StatsCallback = (rows: unknown[]) => void;
type StatsErrorCallback = () => void;

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 5000;
const FAILURE_THRESHOLD = 3;
// While the database is down every poll still pays the full 5s query timeout,
// so retrying each 1s tick keeps a failing connection pinned. Consecutive
// failures stretch the effective spacing by skipping ticks (2s, 4s, 8s, then
// capped at 10s) until one successful poll resets it.
const MAX_BACKOFF_MS = 10_000;

/**
 * Shared poll service that runs one setInterval per source (docker, zfs)
 * and broadcasts results to all subscribed SSE clients.
 *
 * Auto-starts polling when the first subscriber joins for a source,
 * auto-stops when the last subscriber leaves.
 */
class StatsPollService {
  private subscribers = new Map<StatsSource, Set<StatsCallback>>();
  private errorCallbacks = new Map<StatsSource, Set<StatsErrorCallback>>();
  private intervals = new Map<StatsSource, ReturnType<typeof setInterval>>();
  private lastPollTime = new Map<StatsSource, Date>();
  private consecutiveFailures = new Map<StatsSource, number>();
  private skipTicks = new Map<StatsSource, number>();
  private errorSignalled = new Set<StatsSource>();
  private stoppedSources = new Set<StatsSource>();
  // Sources with a poll still in flight. The interval fires every second
  // regardless of how long the previous poll took, so without this guard a
  // run of slow-but-succeeding polls (2-4s under DB load, still under the
  // timeout) stacks several concurrent queries, each holding a pool
  // connection. The guard sheds to one poll at a time instead.
  private inFlight = new Set<StatsSource>();
  private readonly dbConfig = loadDatabaseConfig();

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

      // Skip this tick if the previous poll for this source hasn't finished.
      if (this.inFlight.has(source)) return;
      this.inFlight.add(source);

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        // Rebuild the repo each tick so we pick up a fresh pg.Pool after any
        // reconnect in DatabaseConnectionManager. getClient() is cached on the
        // healthy path, so this costs one Map lookup + a no-op constructor.
        const dbClient = await databaseConnectionManager.getClient(this.dbConfig);
        const repo = new StatsRepository(dbClient.getPool());
        const last = this.lastPollTime.get(source) ?? new Date();
        const since = new Date(last.getTime() - 200); // 200ms lookback for late-committing rows

        const rowsPromise = source === 'docker'
          ? repo.getDockerStatsSince(since)
          : source === 'zfs'
            ? repo.getZFSStatsSince(since)
            : repo.getProxmoxStatsSince(since);

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Poll timeout')), POLL_TIMEOUT_MS);
        });

        const rows = await Promise.race([rowsPromise, timeoutPromise]);

        // Success - reset failure tracking and backoff
        this.consecutiveFailures.set(source, 0);
        this.skipTicks.delete(source);
        this.errorSignalled.delete(source);

        // Only broadcast rows newer than last poll - prevents broadcasting stale data
        // when the worker is down (which would break the 30s stale detection in the frontend)
        const toMs = (value: string | Date) => new Date(value).getTime();
        const newRows = rows.filter(r => toMs(r.time as string | Date) > last.getTime());

        if (newRows.length > 0) {
          // Advance cursor to max observed row time (not wall-clock) to avoid skipping late-committing rows
          const maxSeenTime = rows.reduce(
            (max, r) => Math.max(max, toMs(r.time as string | Date)),
            last.getTime()
          );
          this.lastPollTime.set(source, new Date(maxSeenTime));
          for (const cb of subs) {
            cb(rows); // send all rows including 200ms overlap - frontend Map deduplicates
          }
        }
      } catch (err) {
        console.error(`[StatsPollService] Poll failed for source "${source}":`, err);
        // Track consecutive failures
        const failures = (this.consecutiveFailures.get(source) ?? 0) + 1;
        this.consecutiveFailures.set(source, failures);

        const backoffMs = backoffDelayMs(failures, { baseMs: POLL_INTERVAL_MS, capMs: MAX_BACKOFF_MS });
        // -1 because the current (failing) tick already consumed one interval.
        this.skipTicks.set(source, backoffMs / POLL_INTERVAL_MS - 1);

        // Signal error once per failure episode after hitting the threshold
        if (failures >= FAILURE_THRESHOLD && !this.errorSignalled.has(source)) {
          this.errorSignalled.add(source);
          const errCbs = this.errorCallbacks.get(source);
          if (errCbs) {
            for (const cb of errCbs) cb();
          }
        }
      } finally {
        // Clear the timeout timer whenever the query wins the race, otherwise a
        // pending 5s timer leaks per successful tick and delays clean shutdown.
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

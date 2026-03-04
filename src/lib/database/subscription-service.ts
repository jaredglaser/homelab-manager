import { databaseConnectionManager } from '@/lib/clients/database-client';
import { loadDatabaseConfig } from '@/lib/config/database-config';
import { StatsRepository } from '@/lib/database/repositories/stats-repository';

type StatsSource = 'docker' | 'zfs' | 'proxmox';
type StatsCallback = (rows: unknown[]) => void;
type StatsErrorCallback = () => void;

const POLL_TIMEOUT_MS = 5000;
const FAILURE_THRESHOLD = 3;

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
  private errorSignalled = new Set<StatsSource>();
  private repo: StatsRepository | null = null;
  private stoppedSources = new Set<StatsSource>();

  private async getRepo(): Promise<StatsRepository> {
    if (!this.repo) {
      const config = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(config);
      this.repo = new StatsRepository(dbClient.getPool());
    }
    return this.repo;
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

      try {
        const repo = await this.getRepo();
        const last = this.lastPollTime.get(source) ?? new Date();
        const since = new Date(last.getTime() - 200); // 200ms lookback for late-committing rows

        const rowsPromise = source === 'docker'
          ? repo.getDockerStatsSince(since)
          : source === 'zfs'
            ? repo.getZFSStatsSince(since)
            : repo.getProxmoxStatsSince(since);

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Poll timeout')), POLL_TIMEOUT_MS)
        );

        const rows = await Promise.race([rowsPromise, timeoutPromise]);

        // Success - reset failure tracking
        this.consecutiveFailures.set(source, 0);
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
      } catch {
        // Query failed or timed out - track consecutive failures
        const failures = (this.consecutiveFailures.get(source) ?? 0) + 1;
        this.consecutiveFailures.set(source, failures);

        // Signal error once per failure episode after hitting the threshold
        if (failures >= FAILURE_THRESHOLD && !this.errorSignalled.has(source)) {
          this.errorSignalled.add(source);
          const errCbs = this.errorCallbacks.get(source);
          if (errCbs) {
            for (const cb of errCbs) cb();
          }
        }
      }
    }, 1000);

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
    this.errorSignalled.delete(source);
    this.errorCallbacks.delete(source);
  }

  async stop(): Promise<void> {
    for (const source of this.intervals.keys()) {
      this.stopPolling(source);
    }
    this.subscribers.clear();
    this.repo = null;
  }
}

export const statsPollService = new StatsPollService();

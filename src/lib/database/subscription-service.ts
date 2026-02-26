import { databaseConnectionManager } from '@/lib/clients/database-client';
import { loadDatabaseConfig } from '@/lib/config/database-config';
import { StatsRepository } from '@/lib/database/repositories/stats-repository';

type StatsSource = 'docker' | 'zfs';
type StatsCallback = (rows: unknown[]) => void;

/**
 * Shared poll service that runs one setInterval per source (docker, zfs)
 * and broadcasts results to all subscribed SSE clients.
 *
 * Auto-starts polling when the first subscriber joins for a source,
 * auto-stops when the last subscriber leaves.
 */
class StatsPollService {
  private subscribers = new Map<StatsSource, Set<StatsCallback>>();
  private intervals = new Map<StatsSource, ReturnType<typeof setInterval>>();
  private lastPollTime = new Map<StatsSource, Date>();
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

  subscribe(source: StatsSource, callback: StatsCallback): () => void {
    let subs = this.subscribers.get(source);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(source, subs);
    }
    subs.add(callback);

    if (subs.size === 1) {
      this.startPolling(source);
    }

    return () => {
      subs!.delete(callback);
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

        const rows = source === 'docker'
          ? await repo.getDockerStatsSince(since)
          : await repo.getZFSStatsSince(since);

        // Only broadcast rows newer than last poll — prevents broadcasting stale data
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
            cb(rows); // send all rows including 200ms overlap — frontend Map deduplicates
          }
        }
      } catch (err) {
        console.error('StatsPollService.startPolling query failed:', err);
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

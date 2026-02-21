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
  private lastSeq = new Map<StatsSource, string>();
  private repo: StatsRepository | null = null;

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

  private async startPolling(source: StatsSource): Promise<void> {
    try {
      const repo = await this.getRepo();
      const seq = source === 'docker'
        ? await repo.getMaxDockerSeq()
        : await repo.getMaxZFSSeq();
      this.lastSeq.set(source, seq);
    } catch {
      this.lastSeq.set(source, '0');
    }

    const intervalId = setInterval(async () => {
      const subs = this.subscribers.get(source);
      if (!subs || subs.size === 0) return;

      try {
        const repo = await this.getRepo();
        const lastSeq = this.lastSeq.get(source) ?? '0';

        const rows = source === 'docker'
          ? await repo.getDockerStatsSinceSeq(lastSeq)
          : await repo.getZFSStatsSinceSeq(lastSeq);

        if (rows.length > 0) {
          this.lastSeq.set(source, String((rows[rows.length - 1] as any).seq));
          for (const cb of subs) {
            cb(rows);
          }
        }
      } catch {
        // Query failed — skip this cycle
      }
    }, 1000);

    this.intervals.set(source, intervalId);
  }

  private stopPolling(source: StatsSource): void {
    const intervalId = this.intervals.get(source);
    if (intervalId) {
      clearInterval(intervalId);
      this.intervals.delete(source);
    }
    this.lastSeq.delete(source);
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

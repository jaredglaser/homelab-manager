import type { DockerStatsFromDB } from '@/lib/transformers/docker-transformer';
import type { ZFSStatsFromDB } from '@/lib/transformers/zfs-transformer';
import { filterVisibleZFSStats, sortZFSStats } from '@/lib/transformers/zfs-transformer';

/** Remove stale entries after 5 minutes of no fresh data */
const STALE_EXPIRY_MS = 5 * 60 * 1000;

/**
 * Server-side cache for stats from the database.
 * Shared across all frontend connections to avoid duplicate DB queries.
 *
 * Updated by the SubscriptionService when NOTIFY is received.
 * Read by server functions to yield data to frontends.
 */
class StatsCache {
  private docker: Map<string, DockerStatsFromDB> = new Map();
  private zfs: Map<string, ZFSStatsFromDB> = new Map();
  private lastDockerUpdate: Date | null = null;
  private lastZFSUpdate: Date | null = null;

  /**
   * Merge fresh Docker stats into the cache.
   * - Fresh entries (in new data): updated with stale=false
   * - Retained entries (in old cache, not in new data): kept with stale=true
   * - Expired entries (stale + timestamp > STALE_EXPIRY_MS old): removed
   */
  updateDocker(freshStats: Map<string, DockerStatsFromDB>): void {
    const now = Date.now();
    const merged = new Map<string, DockerStatsFromDB>();

    // Add all fresh entries
    for (const [id, stat] of freshStats) {
      merged.set(id, { ...stat, stale: false });
    }

    // Retain old entries not in fresh set, marking them stale
    for (const [id, oldStat] of this.docker) {
      if (!freshStats.has(id)) {
        const age = now - oldStat.timestamp.getTime();
        if (age < STALE_EXPIRY_MS) {
          merged.set(id, { ...oldStat, stale: true });
        }
      }
    }

    this.docker = merged;
    this.lastDockerUpdate = new Date();
  }

  /**
   * Update ZFS stats in the cache
   */
  updateZFS(stats: Map<string, ZFSStatsFromDB>): void {
    this.zfs = stats;
    this.lastZFSUpdate = new Date();
  }

  /**
   * Get all Docker stats, optionally filtered by entity IDs
   */
  getDocker(entities?: string[]): DockerStatsFromDB[] {
    if (!entities || entities.length === 0) {
      return Array.from(this.docker.values());
    }

    const entitySet = new Set(entities);
    return Array.from(this.docker.values()).filter(s => entitySet.has(s.id));
  }

  /**
   * Get ZFS stats filtered by visibility state.
   * All pools are always returned; vdevs/disks are filtered based on expansion state.
   * Results are sorted in hierarchy order for buildHierarchy().
   */
  getZFS(expandedPools?: string[], expandedVdevs?: string[]): ZFSStatsFromDB[] {
    // If no expansion state provided, return all stats sorted
    if (!expandedPools && !expandedVdevs) {
      return sortZFSStats(Array.from(this.zfs.values()));
    }

    // filterVisibleZFSStats already sorts the results
    return filterVisibleZFSStats(this.zfs, expandedPools, expandedVdevs);
  }

  /**
   * Get the full ZFS stats map (for internal use by subscription service)
   */
  getAllZFS(): Map<string, ZFSStatsFromDB> {
    return this.zfs;
  }

  /**
   * Get the full Docker stats map (for internal use by subscription service)
   */
  getAllDocker(): Map<string, DockerStatsFromDB> {
    return this.docker;
  }

  /**
   * Check if Docker data is stale (no update for more than 30 seconds)
   */
  isDockerStale(): boolean {
    if (!this.lastDockerUpdate) return true;
    return Date.now() - this.lastDockerUpdate.getTime() > 30000;
  }

  /**
   * Check if ZFS data is stale (no update for more than 30 seconds)
   */
  isZFSStale(): boolean {
    if (!this.lastZFSUpdate) return true;
    return Date.now() - this.lastZFSUpdate.getTime() > 30000;
  }

  /**
   * Check if any data is stale
   */
  isStale(): boolean {
    return this.isDockerStale() || this.isZFSStale();
  }

  /**
   * Get last update timestamps
   */
  getLastUpdateTimes(): { docker: Date | null; zfs: Date | null } {
    return {
      docker: this.lastDockerUpdate,
      zfs: this.lastZFSUpdate,
    };
  }

  /**
   * Clear all cached data
   */
  clear(): void {
    this.docker.clear();
    this.zfs.clear();
    this.lastDockerUpdate = null;
    this.lastZFSUpdate = null;
  }
}

/**
 * Singleton instance of the stats cache.
 * Shared across all server function invocations.
 */
export const statsCache = new StatsCache();

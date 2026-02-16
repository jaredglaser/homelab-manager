import type { DockerStatsFromDB } from '@/lib/transformers/docker-transformer';
import type { ZFSStatsFromDB } from '@/lib/transformers/zfs-transformer';
import { filterVisibleZFSStats, sortZFSStats } from '@/lib/transformers/zfs-transformer';
import type { ProxmoxStatsFromDB } from '@/lib/transformers/proxmox-transformer';

/** Remove entries entirely after 5 minutes of no fresh data */
const STALE_EXPIRY_MS = 5 * 60 * 1000;

/** Grace period before marking a missing container as stale */
const STALE_GRACE_MS = 15_000;

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
  private proxmox: Map<string, ProxmoxStatsFromDB> = new Map();
  private lastDockerUpdate: Date | null = null;
  private lastZFSUpdate: Date | null = null;
  private lastProxmoxUpdate: Date | null = null;

  /** Tracks when each Docker container was last seen in fresh query results */
  private dockerLastSeen: Map<string, number> = new Map();

  /** Tracks when each Proxmox entity was last seen in fresh query results */
  private proxmoxLastSeen: Map<string, number> = new Map();

  /**
   * Merge fresh Docker stats into the cache.
   * - Fresh entries (in new data): updated with stale=false, lastSeen=now
   * - Missing entries (in old cache, not in new data):
   *   - Within grace period: kept with stale=false (timing jitter tolerance)
   *   - Past grace period: marked stale=true
   *   - Past expiry: removed entirely
   */
  updateDocker(freshStats: Map<string, DockerStatsFromDB>): void {
    const now = Date.now();
    const merged = new Map<string, DockerStatsFromDB>();

    // Add all fresh entries
    for (const [id, stat] of freshStats) {
      merged.set(id, { ...stat, stale: false });
      this.dockerLastSeen.set(id, now);
    }

    // Retain old entries not in fresh set
    for (const [id, oldStat] of this.docker) {
      if (!freshStats.has(id)) {
        const lastSeen = this.dockerLastSeen.get(id) ?? 0;
        const sinceSeen = now - lastSeen;

        if (sinceSeen >= STALE_EXPIRY_MS) {
          // Too old — drop entirely
          this.dockerLastSeen.delete(id);
        } else if (sinceSeen >= STALE_GRACE_MS) {
          // Past grace period — mark stale
          merged.set(id, { ...oldStat, stale: true });
        } else {
          // Within grace period — keep as fresh
          merged.set(id, { ...oldStat, stale: false });
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
   * Merge fresh Proxmox stats into the cache.
   * Same stale-tracking pattern as Docker.
   */
  updateProxmox(freshStats: Map<string, ProxmoxStatsFromDB>): void {
    const now = Date.now();
    const merged = new Map<string, ProxmoxStatsFromDB>();

    for (const [id, stat] of freshStats) {
      merged.set(id, { ...stat, stale: false });
      this.proxmoxLastSeen.set(id, now);
    }

    for (const [id, oldStat] of this.proxmox) {
      if (!freshStats.has(id)) {
        const lastSeen = this.proxmoxLastSeen.get(id) ?? 0;
        const sinceSeen = now - lastSeen;

        if (sinceSeen >= STALE_EXPIRY_MS) {
          this.proxmoxLastSeen.delete(id);
        } else if (sinceSeen >= STALE_GRACE_MS) {
          merged.set(id, { ...oldStat, stale: true });
        } else {
          merged.set(id, { ...oldStat, stale: false });
        }
      }
    }

    this.proxmox = merged;
    this.lastProxmoxUpdate = new Date();
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
   * Get all Proxmox stats
   */
  getProxmox(): ProxmoxStatsFromDB[] {
    return Array.from(this.proxmox.values());
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
   * Get the full Proxmox stats map (for internal use by subscription service)
   */
  getAllProxmox(): Map<string, ProxmoxStatsFromDB> {
    return this.proxmox;
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
   * Check if Proxmox data is stale (no update for more than 30 seconds)
   */
  isProxmoxStale(): boolean {
    if (!this.lastProxmoxUpdate) return true;
    return Date.now() - this.lastProxmoxUpdate.getTime() > 30000;
  }

  /**
   * Check if any data is stale
   */
  isStale(): boolean {
    return this.isDockerStale() || this.isZFSStale() || this.isProxmoxStale();
  }

  /**
   * Get last update timestamps
   */
  getLastUpdateTimes(): { docker: Date | null; zfs: Date | null; proxmox: Date | null } {
    return {
      docker: this.lastDockerUpdate,
      zfs: this.lastZFSUpdate,
      proxmox: this.lastProxmoxUpdate,
    };
  }

  /**
   * Clear all cached data
   */
  clear(): void {
    this.docker.clear();
    this.zfs.clear();
    this.proxmox.clear();
    this.dockerLastSeen.clear();
    this.proxmoxLastSeen.clear();
    this.lastDockerUpdate = null;
    this.lastZFSUpdate = null;
    this.lastProxmoxUpdate = null;
  }
}

/**
 * Singleton instance of the stats cache.
 * Shared across all server function invocations.
 */
export const statsCache = new StatsCache();

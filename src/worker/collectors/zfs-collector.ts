import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import { sshConnectionManager } from '@/lib/clients/ssh-client';
import { ZFSRateCalculator } from '@/lib/utils/zfs-rate-calculator';
import { streamTextLines } from '@/lib/parsers/text-parser';
import { parseZFSIOStat } from '@/lib/parsers/zfs-iostat-parser';
import type { ZFSIOStatWithRates, ZFSStatsRow } from '@/types/zfs';
import { BaseCollector } from './base-collector';

/**
 * Detects the hierarchy level based on indentation from zpool iostat -vvv output
 *   indent 0  → pool (top-level)
 *   indent 2  → vdev (mirror-N, raidz-N, or single-disk acting as vdev)
 *   indent 4+ → disk (individual drive under a vdev)
 */
function detectHierarchyLevel(indent: number): 'pool' | 'vdev' | 'disk' {
  if (indent <= 0) return 'pool';
  if (indent <= 2) return 'vdev';
  return 'disk';
}

/** Holds current position in hierarchy for building entity paths */
interface HierarchyContext {
  currentPool: string | null;
  currentVdev: string | null;
}

/**
 * Builds the hierarchical entity path based on indent level
 * - Pool: "poolname"
 * - Vdev: "poolname/vdevname"
 * - Disk: "poolname/vdevname/diskname"
 */
function buildEntityPath(stat: ZFSIOStatWithRates, ctx: HierarchyContext): { path: string; pool: string; entityType: string; ctx: HierarchyContext } {
  const level = detectHierarchyLevel(stat.indent);

  switch (level) {
    case 'pool':
      return {
        path: stat.name,
        pool: stat.name,
        entityType: 'pool',
        ctx: { currentPool: stat.name, currentVdev: null },
      };
    case 'vdev': {
      const vdevPath = ctx.currentPool ? `${ctx.currentPool}/${stat.name}` : stat.name;
      return {
        path: vdevPath,
        pool: ctx.currentPool || stat.name,
        entityType: 'vdev',
        ctx: { ...ctx, currentVdev: vdevPath },
      };
    }
    case 'disk': {
      const parentPath = ctx.currentVdev || ctx.currentPool;
      const diskPath = parentPath ? `${parentPath}/${stat.name}` : stat.name;
      return {
        path: diskPath,
        pool: ctx.currentPool || stat.name,
        entityType: 'disk',
        ctx, // Disk doesn't change context
      };
    }
  }
}

function toZFSStatsRow(stat: ZFSIOStatWithRates, entityPath: string, pool: string, entityType: string): ZFSStatsRow {
  return {
    time: new Date(stat.timestamp),
    pool,
    entity: entityPath,
    entity_type: entityType,
    indent: stat.indent,
    capacity_alloc: Math.trunc(stat.capacity.alloc),
    capacity_free: Math.trunc(stat.capacity.free),
    read_ops_per_sec: stat.rates.readOpsPerSec,
    write_ops_per_sec: stat.rates.writeOpsPerSec,
    read_bytes_per_sec: stat.rates.readBytesPerSec,
    write_bytes_per_sec: stat.rates.writeBytesPerSec,
    utilization_percent: stat.rates.utilizationPercent,
  };
}

export class ZFSCollector extends BaseCollector {
  readonly name = 'ZFSCollector';
  private readonly calculator = new ZFSRateCalculator();
  private lastWriteTime = 0;

  constructor(db: DatabaseClient, config: WorkerConfig, abortController?: AbortController) {
    super(db, config, abortController);
  }

  protected isConfigured(): boolean {
    return !!(process.env.ZFS_SSH_HOST && process.env.ZFS_SSH_USER);
  }

  private shouldWrite(): boolean {
    const now = Date.now();
    if (now - this.lastWriteTime < this.config.collection.interval) return false;
    this.lastWriteTime = now;
    return true;
  }

  protected async collectOnce(): Promise<void> {
    const sshClient = await sshConnectionManager.getClient({
      id: 'ssh-worker-zfs',
      type: 'ssh',
      host: process.env.ZFS_SSH_HOST!,
      port: parseInt(process.env.ZFS_SSH_PORT || '22', 10),
      auth: {
        type: process.env.ZFS_SSH_KEY_PATH ? 'privateKey' : 'password',
        username: process.env.ZFS_SSH_USER!,
        ...(process.env.ZFS_SSH_KEY_PATH && { privateKeyPath: process.env.ZFS_SSH_KEY_PATH }),
        ...(process.env.ZFS_SSH_PASSWORD && { password: process.env.ZFS_SSH_PASSWORD }),
      },
    });

    this.debugLog(`[${this.name}] Connected to ZFS host, starting iostat stream`);
    this.resetBackoff();

    const stream = await sshClient.exec('zpool iostat -vvv 1');
    let currentCycle: ZFSStatsRow[] = [];
    let hierarchyCtx: HierarchyContext = { currentPool: null, currentVdev: null };

    for await (const line of streamTextLines(stream)) {
      if (this.signal.aborted) break;

      if (!line.trim()) continue;

      // Detect cycle boundary (header line)
      if (
        line.includes('capacity') &&
        line.includes('operations') &&
        line.includes('bandwidth')
      ) {
        if (currentCycle.length > 0 && this.shouldWrite()) {
          await this.repository.insertZFSStats(currentCycle);
          this.dbDebugLog(`[${this.name}] Wrote ${currentCycle.length} zfs rows`);
        }
        currentCycle = [];
        hierarchyCtx = { currentPool: null, currentVdev: null };
        continue;
      }

      const parsed = parseZFSIOStat(line);
      if (!parsed) continue;

      const statsWithRates = this.calculator.calculate(parsed.name, parsed);

      const { path: entityPath, pool, entityType, ctx: newCtx } = buildEntityPath(statsWithRates, hierarchyCtx);
      hierarchyCtx = newCtx;

      currentCycle.push(toZFSStatsRow(statsWithRates, entityPath, pool, entityType));
    }

    // Flush final cycle
    if (currentCycle.length > 0 && this.shouldWrite()) {
      await this.repository.insertZFSStats(currentCycle);
      this.dbDebugLog(`[${this.name}] Wrote ${currentCycle.length} zfs rows (final)`);
    }
  }
}

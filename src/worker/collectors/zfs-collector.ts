import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import { sshConnectionManager } from '@/lib/clients/ssh-client';
import { ZFSRateCalculator } from '@/lib/utils/zfs-rate-calculator';
import type { RawStatRow } from '@/lib/database/repositories/stats-repository';
import { streamTextLines } from '@/lib/parsers/text-parser';
import { parseZFSIOStat } from '@/lib/parsers/zfs-iostat-parser';
import type { ZFSIOStatWithRates } from '@/types/zfs';
import { BaseCollector } from './base-collector';

const ZFS_SOURCE = 'zfs';

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

function toRawStatRows(stat: ZFSIOStatWithRates, entityPath: string): RawStatRow[] {
  const timestamp = new Date(stat.timestamp);

  return [
    { timestamp, source: ZFS_SOURCE, type: 'capacity_alloc', entity: entityPath, value: stat.capacity.alloc },
    { timestamp, source: ZFS_SOURCE, type: 'capacity_free', entity: entityPath, value: stat.capacity.free },
    { timestamp, source: ZFS_SOURCE, type: 'read_ops_per_sec', entity: entityPath, value: stat.rates.readOpsPerSec },
    { timestamp, source: ZFS_SOURCE, type: 'write_ops_per_sec', entity: entityPath, value: stat.rates.writeOpsPerSec },
    { timestamp, source: ZFS_SOURCE, type: 'read_bytes_per_sec', entity: entityPath, value: stat.rates.readBytesPerSec },
    { timestamp, source: ZFS_SOURCE, type: 'write_bytes_per_sec', entity: entityPath, value: stat.rates.writeBytesPerSec },
    { timestamp, source: ZFS_SOURCE, type: 'utilization_percent', entity: entityPath, value: stat.rates.utilizationPercent },
  ];
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
function buildEntityPath(stat: ZFSIOStatWithRates, ctx: HierarchyContext): { path: string; ctx: HierarchyContext } {
  const level = detectHierarchyLevel(stat.indent);

  switch (level) {
    case 'pool':
      return {
        path: stat.name,
        ctx: { currentPool: stat.name, currentVdev: null },
      };
    case 'vdev': {
      const vdevPath = ctx.currentPool ? `${ctx.currentPool}/${stat.name}` : stat.name;
      return {
        path: vdevPath,
        ctx: { ...ctx, currentVdev: vdevPath },
      };
    }
    case 'disk': {
      // If we have a vdev, disk is under vdev; otherwise under pool directly
      const parentPath = ctx.currentVdev || ctx.currentPool;
      const diskPath = parentPath ? `${parentPath}/${stat.name}` : stat.name;
      return {
        path: diskPath,
        ctx, // Disk doesn't change context
      };
    }
  }
}

export class ZFSCollector extends BaseCollector {
  readonly name = 'ZFSCollector';
  private readonly calculator = new ZFSRateCalculator();

  constructor(db: DatabaseClient, config: WorkerConfig, abortController?: AbortController) {
    super(db, config, abortController);
  }

  protected isConfigured(): boolean {
    return !!(process.env.ZFS_SSH_HOST && process.env.ZFS_SSH_USER);
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

    console.log(`[${this.name}] Connected to ZFS host, starting iostat stream`);
    this.resetBackoff();

    const stream = await sshClient.exec('zpool iostat -vvv 1');
    // Store stats with their hierarchical entity paths
    let currentCycle: { stat: ZFSIOStatWithRates; entityPath: string }[] = [];
    // Track hierarchy position for building entity paths
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
        if (currentCycle.length > 0) {
          await this.addToBatch(currentCycle.flatMap(({ stat, entityPath }) => toRawStatRows(stat, entityPath)));
          currentCycle = [];
        }
        // Reset hierarchy context at cycle boundary
        hierarchyCtx = { currentPool: null, currentVdev: null };
        continue;
      }

      const parsed = parseZFSIOStat(line);
      if (!parsed) continue;

      const statsWithRates = this.calculator.calculate(parsed.name, parsed);

      // Build hierarchical entity path and update context
      const { path: entityPath, ctx: newCtx } = buildEntityPath(statsWithRates, hierarchyCtx);
      hierarchyCtx = newCtx;

      currentCycle.push({ stat: statsWithRates, entityPath });
    }

    // Flush final cycle
    if (currentCycle.length > 0) {
      await this.addToBatch(currentCycle.flatMap(({ stat, entityPath }) => toRawStatRows(stat, entityPath)));
    }
  }
}

import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ZFSHostConfig } from '@/lib/config/zfs-config';
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

function toZFSStatsRow(stat: ZFSIOStatWithRates, host: string, entityPath: string, pool: string, entityType: string): ZFSStatsRow {
  return {
    time: new Date(stat.timestamp),
    host,
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
  readonly name: string;
  private readonly calculator = new ZFSRateCalculator();
  private readonly hostConfig: ZFSHostConfig;

  constructor(db: DatabaseClient, config: WorkerConfig, hostConfig: ZFSHostConfig, abortController?: AbortController) {
    super(db, config, abortController);
    this.hostConfig = hostConfig;
    this.name = `ZFSCollector[${hostConfig.name}]`;
  }

  protected isConfigured(): boolean {
    return !!this.hostConfig.host;
  }

  protected async collect(): Promise<void> {
    if (!this.hostConfig.privateKeyPath && !this.hostConfig.password) {
      console.error(
        `[${this.name}] No SSH credentials configured for host ${this.hostConfig.host}: ` +
          `set ZFS_HOST_KEY_PATH_N or ZFS_HOST_PASSWORD_N`
      );
      throw new Error(`No SSH credentials configured for host ${this.hostConfig.host}`);
    }

    const sshClient = await sshConnectionManager.getClient({
      id: `ssh-worker-zfs-${this.hostConfig.host}:${this.hostConfig.port}`,
      type: 'ssh',
      host: this.hostConfig.host,
      port: this.hostConfig.port,
      auth: {
        type: this.hostConfig.privateKeyPath ? 'privateKey' : 'password',
        username: this.hostConfig.username,
        ...(this.hostConfig.privateKeyPath && { privateKeyPath: this.hostConfig.privateKeyPath }),
        ...(this.hostConfig.passphrase && { passphrase: this.hostConfig.passphrase }),
        ...(this.hostConfig.password && { password: this.hostConfig.password }),
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
        // Write complete cycle immediately (no throttling)
        if (currentCycle.length > 0) {
          const t0Write = performance.now();
          await this.repository.insertZFSStats(currentCycle);
          const writeMs = (performance.now() - t0Write).toFixed(1);
          this.dbDebugLog(`[${this.name}] Wrote ${currentCycle.length} ZFS rows in ${writeMs}ms`);
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

      currentCycle.push(toZFSStatsRow(statsWithRates, this.hostConfig.name, entityPath, pool, entityType));
    }

    // Write final cycle
    if (currentCycle.length > 0) {
      await this.repository.insertZFSStats(currentCycle);
      this.dbDebugLog(`[${this.name}] Wrote ${currentCycle.length} ZFS rows (final)`);
    }
  }
}

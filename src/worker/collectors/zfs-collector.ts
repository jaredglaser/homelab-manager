import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import { ZFSRateCalculator } from '@/lib/utils/zfs-rate-calculator';
import { parseZFSIOStat } from '@/lib/parsers/zfs-iostat-parser';
import type { ZFSIOStatWithRates, ZFSStatsRow } from '@/types/zfs';
import { BaseCollector } from './base-collector';
import { connectAgentSseStream } from './agent-sse-stream';

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

/** Injectable connector so tests can supply parsed events without opening a byte stream. */
type StreamConnector = typeof connectAgentSseStream;

/** Shape of SSE events emitted by the agent's GET /zfs/stats/stream endpoint */
interface AgentZfsStatsEvent {
  line: string;
  timestamp?: number;
}

export class ZFSCollector extends BaseCollector {
  readonly name: string;
  private readonly calculator = new ZFSRateCalculator();
  private readonly host: ManagedHost;
  private readonly signer: () => Promise<string>;
  private readonly streamConnector: StreamConnector;

  constructor(
    db: DatabaseClient,
    config: WorkerConfig,
    host: ManagedHost,
    signer: () => Promise<string>,
    abortController?: AbortController,
    streamConnector?: StreamConnector,
  ) {
    super(db, config, abortController);
    this.host = host;
    this.signer = signer;
    this.name = `ZFSCollector[${host.name}]`;
    this.streamConnector = streamConnector ?? connectAgentSseStream;
  }

  protected async collect(): Promise<void> {
    this.debugLog(`[${this.name}] Connecting to ${this.host.agentUrl}/zfs/stats/stream`);

    const stream = await this.streamConnector({
      agentUrl: this.host.agentUrl,
      path: '/zfs/stats/stream',
      signer: this.signer,
      signal: this.signal,
    });

    this.resetBackoff();
    this.debugLog(`[${this.name}] Connected, reading ZFS stats SSE stream`);

    let currentCycle: ZFSStatsRow[] = [];
    let hierarchyCtx: HierarchyContext = { currentPool: null, currentVdev: null };

    try {
      for await (const frame of stream) {
        if (this.signal.aborted) break;
        if (typeof frame !== 'object' || frame === null) continue;

        // Skip error events from the agent
        if ('error' in frame && !('line' in frame)) continue;

        const event = frame as AgentZfsStatsEvent;
        const agentTimestamp = event.timestamp ?? Date.now();
        const line = event.line;
        if (!line || !line.trim()) continue;

        // Detect cycle boundary (header line)
        if (
          line.includes('capacity') &&
          line.includes('operations') &&
          line.includes('bandwidth')
        ) {
          // Write complete cycle
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

        const iostat = parseZFSIOStat(line);
        if (!iostat) continue;

        const statsWithRates = this.calculator.calculate(iostat.name, iostat);
        statsWithRates.timestamp = agentTimestamp;

        let hostId: string;
        try {
          const parsedAgentUrl = new URL(this.host.agentUrl);
          hostId = parsedAgentUrl.hostname + (parsedAgentUrl.port ? `:${parsedAgentUrl.port}` : '');
        } catch {
          hostId = this.host.agentUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
        }
        const { path: entityPath, pool, entityType, ctx: newCtx } = buildEntityPath(statsWithRates, hierarchyCtx);
        hierarchyCtx = newCtx;

        currentCycle.push(toZFSStatsRow(statsWithRates, this.host.name, `${hostId}/${entityPath}`, pool, entityType));
      }
    } finally {
      // Write final cycle
      if (currentCycle.length > 0) {
        await this.repository.insertZFSStats(currentCycle);
        this.dbDebugLog(`[${this.name}] Wrote ${currentCycle.length} ZFS rows (final)`);
      }

      this.debugLog(
        `[${this.name}] Stream ended (aborted=${this.signal.aborted})`
      );
    }
  }
}

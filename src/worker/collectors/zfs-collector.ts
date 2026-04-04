import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ManagedHostRow } from '@/lib/database/repositories/host-repository';
import { ZFSRateCalculator } from '@/lib/utils/zfs-rate-calculator';
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

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Shape of SSE events emitted by the agent's GET /zfs/stats/stream endpoint */
interface AgentZfsStatsEvent {
  line: string;
  timestamp?: number;
}

export class ZFSCollector extends BaseCollector {
  readonly name: string;
  private readonly calculator = new ZFSRateCalculator();
  private readonly host: ManagedHostRow;
  private readonly token: string;
  private readonly fetchFn: FetchFn;

  constructor(
    db: DatabaseClient,
    config: WorkerConfig,
    host: ManagedHostRow,
    token: string,
    abortController?: AbortController,
    fetchFn?: FetchFn,
  ) {
    super(db, config, abortController);
    this.host = host;
    this.token = token;
    this.name = `ZFSCollector[${host.name}]`;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  protected async collect(): Promise<void> {
    let url: string;
    try {
      const parsed = new URL(this.host.agent_url);
      parsed.pathname = parsed.pathname.replace(/\/$/, '') + '/zfs/stats/stream';
      url = parsed.toString();
    } catch {
      url = `${this.host.agent_url}/zfs/stats/stream`;
    }
    this.debugLog(`[${this.name}] Connecting to ${url}`);

    const response = await this.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      signal: this.signal,
    });

    if (!response.ok) {
      throw new Error(`Agent returned ${response.status}: ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Agent response has no body');
    }

    this.resetBackoff();
    this.debugLog(`[${this.name}] Connected, reading ZFS stats SSE stream`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentCycle: ZFSStatsRow[] = [];
    let hierarchyCtx: HierarchyContext = { currentPool: null, currentVdev: null };

    try {
      while (!this.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE messages (separated by double newlines)
        const messages = buffer.split('\n\n');
        // Keep the last incomplete chunk in the buffer
        buffer = messages.pop() ?? '';

        for (const message of messages) {
          if (this.signal.aborted) break;
          if (!message.trim()) continue;

          // Extract data from SSE "data: " prefix
          const dataLine = message
            .split('\n')
            .find(ln => ln.startsWith('data: '));

          if (!dataLine) continue;

          const jsonStr = dataLine.slice(6); // Remove "data: " prefix
          let parsed: unknown;
          try {
            parsed = JSON.parse(jsonStr);
          } catch {
            console.error(`[${this.name}] Failed to parse SSE event: ${jsonStr.substring(0, 100)}`);
            continue;
          }

          if (typeof parsed !== 'object' || parsed === null) continue;

          // Skip error events from the agent
          if ('error' in parsed && !('line' in parsed)) continue;

          const event = parsed as AgentZfsStatsEvent;
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
            const parsed = new URL(this.host.agent_url);
            hostId = parsed.hostname + (parsed.port ? `:${parsed.port}` : '');
          } catch {
            hostId = this.host.agent_url.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
          }
          const { path: entityPath, pool, entityType, ctx: newCtx } = buildEntityPath(statsWithRates, hierarchyCtx);
          hierarchyCtx = newCtx;

          currentCycle.push(toZFSStatsRow(statsWithRates, this.host.name, `${hostId}/${entityPath}`, pool, entityType));
        }
      }
    } finally {
      reader.releaseLock();

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

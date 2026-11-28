import type { NewZFSStat } from '@/lib/database/repositories/stats-repository';
import type { ZfsNodeConnection } from '@/lib/database/repositories/zfs-node-repository';
import type { ZfsNodeFailure } from '@/lib/zfs/node-state';
import { DISPATCH_EXIT_MISSING, ZFS_INFLUXDB_COMMAND, ZFS_STATUS_COMMAND } from '@/lib/zfs/node-setup-script';
import { failureFromError } from '@/lib/zfs/node-probe';
import { ZfsSshError, printableNodeText, type ZfsSshSession, type ZfsSshTransport } from '@/lib/zfs/ssh-transport';
import { parseInfluxLine, type ZpoolStatsLine } from '@/lib/zfs/zpool-influxdb';
import { readZpoolStatus, type StatusPool } from '@/lib/zfs/zpool-status';
import { buildZfsSampleRows, ZfsCounterTracker } from '@/lib/zfs/zfs-sample';
import { abortableSleep } from '@/lib/utils/abortable-sleep';
import { BaseCollector } from '@/worker/collectors/base-collector';

export const ZFS_SAMPLE_INTERVAL_MS = 1000;
export const ZFS_STATUS_EVERY_SAMPLES = 5;
/** A read with no answer for this long counts as hung: a suspended pool blocks the command in the kernel. */
export const ZFS_SAMPLE_TIMEOUT_MS = 10_000;
export const ZFS_CONNECT_TIMEOUT_MS = 10_000;
export const ZFS_LIVENESS_TIMEOUT_MS = 5000;
/** Backoff resets only after a session stayed up this long, so a node that drops every few seconds keeps backing off. */
export const ZFS_HEALTHY_SESSION_MS = 60_000;
/** A changed host key or a hung node does not fix itself in seconds, and each reconnect to a hung node leaves one more stuck process on it. */
export const ZFS_SLOW_RETRY_MS = 300_000;
/** A pool with a few hundred disks prints well under this many lines per sample. */
export const ZFS_MAX_SAMPLE_LINES = 20_000;
/** last_success_at is shown to the minute, so writing it on every sample would only add load. */
const SUCCESS_WRITE_INTERVAL_MS = 15_000;
const MAX_LINE_BYTES = 1024 * 1024;

export interface ZfsNodeStateSink {
  recordFailure(id: number, state: ZfsNodeFailure, seenFingerprint?: string | null): Promise<void>;
  recordSuccess(id: number, at: Date): Promise<void>;
}

export interface ZfsNodeCollectorDeps {
  transport: ZfsSshTransport;
  states: ZfsNodeStateSink;
  insertRows: (rows: NewZFSStat[]) => Promise<void>;
  now?: () => number;
  /** Waits one sample interval. Tests replace it to step the loop. */
  tick?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class ZfsNodeReadError extends Error {
  constructor(readonly state: ZfsNodeFailure, message: string) {
    super(message);
    this.name = 'ZfsNodeReadError';
  }
}

type Target = Pick<ZfsNodeConnection, 'id' | 'name' | 'address' | 'port' | 'username' | 'privateKey' | 'hostKeyFingerprint'>;

interface SampleRequest {
  sentAt: number;
  lines: ZpoolStatsLine[];
  endedPools: Set<string>;
  dataSinceTick: boolean;
  ticks: number;
}

export class ZfsNodeCollector extends BaseCollector {
  readonly name: string;
  private readonly now: () => number;
  private readonly tick: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly loggedLines = new Set<string>();
  private lastSuccessWrite = 0;
  private lastRecordedOk = false;
  private recordedTimeout = false;

  constructor(
    private readonly node: Target,
    private readonly deps: ZfsNodeCollectorDeps,
    abortController?: AbortController,
  ) {
    super(undefined, undefined, abortController);
    this.name = `ZfsNodeCollector(${node.name})`;
    this.now = deps.now ?? Date.now;
    this.tick = deps.tick ?? abortableSleep;
  }

  protected override retryFloorMs(err: unknown): number {
    if (err instanceof ZfsNodeReadError && (err.state === 'host_key_changed' || err.state === 'timeout')) return ZFS_SLOW_RETRY_MS;
    return 0;
  }

  private async recordFailure(state: ZfsNodeFailure, fingerprint: string | null = null): Promise<void> {
    this.lastRecordedOk = false;
    try {
      await this.deps.states.recordFailure(this.node.id, state, fingerprint);
    } catch (err) {
      console.error(`[${this.name}] recording state ${state} failed:`, err instanceof Error ? err.message : err);
    }
  }

  private async recordSuccess(): Promise<void> {
    const now = this.now();
    if (this.lastRecordedOk && now - this.lastSuccessWrite < SUCCESS_WRITE_INTERVAL_MS) return;
    try {
      await this.deps.states.recordSuccess(this.node.id, new Date(now));
      this.lastRecordedOk = true;
      this.lastSuccessWrite = now;
    } catch (err) {
      console.error(`[${this.name}] recording success failed:`, err instanceof Error ? err.message : err);
    }
  }

  private async markTimeout(): Promise<void> {
    if (this.recordedTimeout) return;
    this.recordedTimeout = true;
    await this.recordFailure('timeout');
  }

  private async connect(): Promise<ZfsSshSession | null> {
    const pinned = this.node.hostKeyFingerprint;
    try {
      return await this.deps.transport.connect(
        { host: this.node.address, port: this.node.port, username: this.node.username, privateKey: this.node.privateKey },
        { acceptHostKey: (fingerprint) => pinned !== null && fingerprint === pinned, timeoutMs: ZFS_CONNECT_TIMEOUT_MS, signal: this.signal },
      );
    } catch (err) {
      if (this.signal.aborted) return null;
      if (err instanceof ZfsSshError && err.kind === 'host_key') {
        console.error(`[${this.name}] host key ${err.fingerprint ?? 'unknown'} does not match the confirmed key, reading nothing`);
        await this.recordFailure('host_key_changed', err.fingerprint);
        throw new ZfsNodeReadError('host_key_changed', 'The node presented a host key that is not the confirmed one');
      }
      await this.recordFailure(failureFromError(err));
      throw err;
    }
  }

  private logLineOnce(reason: string, line: string): void {
    if (this.loggedLines.has(reason) || this.loggedLines.size > 50) return;
    this.loggedLines.add(reason);
    console.error(`[${this.name}] skipping a zpool_influxdb line it cannot read (${reason}): ${printableNodeText(line, 200)}`);
  }

  protected async collect(): Promise<void> {
    const session = await this.connect();
    if (!session) return;
    const sessionStartedAt = this.now();
    this.recordedTimeout = false;

    let ended: ZfsNodeReadError | null = null;
    const sessionEnded = new AbortController();
    const waitSignal = AbortSignal.any([this.signal, sessionEnded.signal]);
    const end = (error: ZfsNodeReadError) => {
      if (ended) return;
      ended = error;
      sessionEnded.abort();
      session.close();
    };
    const onAbort = () => session.close();
    this.signal.addEventListener('abort', onAbort, { once: true });
    session.onClose(() => end(new ZfsNodeReadError('unreachable', 'The SSH connection closed')));

    try {
      const stream = await session.stream(ZFS_INFLUXDB_COMMAND);
      stream.onClose((code, stderr) => {
        const detail = printableNodeText(stderr.trim());
        if (code === DISPATCH_EXIT_MISSING) end(new ZfsNodeReadError('influxdb_missing', detail));
        else if (code === null) end(new ZfsNodeReadError('unreachable', 'The zpool_influxdb channel closed without an exit status'));
        else end(new ZfsNodeReadError('error', `zpool_influxdb exited with ${code}: ${detail}`));
      });

      const tracker = new ZfsCounterTracker();
      let layout: StatusPool[] | null = null;
      let statusStartedAt: number | null = null;
      let statusHung = false;
      let influxHung = false;
      let request: SampleRequest | null = null;
      let text = '';

      const isComplete = (pending: SampleRequest): boolean => {
        if (layout !== null && layout.length > 0 && layout.every((pool) => pending.endedPools.has(pool.name))) return true;
        if (pending.ticks === 0 || pending.dataSinceTick) return false;
        return pending.lines.length > 0 || (layout !== null && layout.length === 0);
      };

      stream.onData((chunk) => {
        text += chunk;
        let newline = text.indexOf('\n');
        while (newline !== -1) {
          const line = text.slice(0, newline);
          text = text.slice(newline + 1);
          newline = text.indexOf('\n');
          if (line.trim() === '' || !request) continue;
          request.dataSinceTick = true;
          influxHung = false;
          const parsed = parseInfluxLine(line);
          if (parsed.kind === 'stats') {
            request.lines.push(parsed.line);
            if (request.lines.length > ZFS_MAX_SAMPLE_LINES) {
              end(new ZfsNodeReadError('error', `zpool_influxdb printed more than ${ZFS_MAX_SAMPLE_LINES} lines for one sample`));
              return;
            }
          } else if (parsed.kind === 'pool-end') {
            request.endedPools.add(parsed.pool);
          } else if (parsed.kind === 'malformed') {
            this.logLineOnce(parsed.reason, line);
          }
        }
        if (text.length > MAX_LINE_BYTES) end(new ZfsNodeReadError('error', 'zpool_influxdb printed a line longer than 1 MiB'));
      });

      const refreshLayout = async () => {
        statusStartedAt = this.now();
        try {
          const result = await session.exec(ZFS_STATUS_COMMAND, null);
          if (result.code === null) return;
          if (result.code !== 0) {
            end(new ZfsNodeReadError('error', `zpool status exited with ${result.code}: ${printableNodeText(result.stderr.trim())}`));
            return;
          }
          layout = readZpoolStatus(result.stdout);
          statusHung = false;
        } catch (err) {
          end(new ZfsNodeReadError(failureFromError(err), err instanceof Error ? err.message : String(err)));
        } finally {
          statusStartedAt = null;
        }
      };

      let sample = 0;
      while (!this.signal.aborted && !ended) {
        if (statusStartedAt === null && sample % ZFS_STATUS_EVERY_SAMPLES === 0) void refreshLayout();
        sample++;

        if (statusStartedAt !== null && !statusHung && this.now() - statusStartedAt >= ZFS_SAMPLE_TIMEOUT_MS) {
          statusHung = true;
          console.error(`[${this.name}] zpool status gave no answer for ${ZFS_SAMPLE_TIMEOUT_MS}ms, keeping the last layout`);
          await this.markTimeout();
        }

        if (request) {
          if (isComplete(request)) {
            const lines = request.lines;
            request = null;
            await this.writeSample(lines, layout, tracker, statusHung, sessionStartedAt);
          } else if (!influxHung && request.lines.length === 0 && this.now() - request.sentAt >= ZFS_SAMPLE_TIMEOUT_MS) {
            if (!(await session.isResponsive(ZFS_LIVENESS_TIMEOUT_MS))) {
              end(new ZfsNodeReadError('unreachable', 'The node stopped answering over SSH'));
              break;
            }
            influxHung = true;
            console.error(`[${this.name}] zpool_influxdb gave no answer for ${ZFS_SAMPLE_TIMEOUT_MS}ms while the node still answers, waiting for it`);
            await this.markTimeout();
          } else {
            request.dataSinceTick = false;
            request.ticks++;
          }
        }
        if (!request && !ended) {
          request = { sentAt: this.now(), lines: [], endedPools: new Set(), dataSinceTick: false, ticks: 0 };
          stream.write('\n');
        }

        try {
          await this.tick(ZFS_SAMPLE_INTERVAL_MS, waitSignal);
        } catch {
          break;
        }
      }
    } catch (err) {
      if (!ended) end(new ZfsNodeReadError(failureFromError(err), err instanceof Error ? err.message : String(err)));
    } finally {
      this.signal.removeEventListener('abort', onAbort);
      session.close();
    }

    if (this.signal.aborted) return;
    const failure = ended as ZfsNodeReadError | null;
    if (failure) {
      await this.recordFailure(failure.state);
      throw failure;
    }
  }

  private async writeSample(
    lines: ZpoolStatsLine[],
    layout: StatusPool[] | null,
    tracker: ZfsCounterTracker,
    statusHung: boolean,
    sessionStartedAt: number,
  ): Promise<void> {
    const rows = buildZfsSampleRows({ host: this.node.name, time: new Date(this.now()), lines, layout, tracker });
    try {
      await this.deps.insertRows(rows);
    } catch (err) {
      console.error(`[${this.name}] writing ${rows.length} row(s) failed:`, err instanceof Error ? err.message : err);
      return;
    }
    if (this.now() - sessionStartedAt >= ZFS_HEALTHY_SESSION_MS) this.resetBackoff();
    if (statusHung) return;
    this.recordedTimeout = false;
    await this.recordSuccess();
  }
}

import type { NewZFSStat } from '@/lib/database/repositories/stats-repository';
import type { ZfsNodeConnection } from '@/lib/database/repositories/zfs-node-repository';
import type { ZfsNodeFailure } from '@/lib/zfs/node-state';
import { DISPATCH_EXIT_MISSING, ZFS_INFLUXDB_COMMAND, ZFS_STATUS_COMMAND } from '@/lib/zfs/node-setup-script';
import { failureFromError } from '@/lib/zfs/node-probe';
import { ZfsSshError, type ZfsSshSession, type ZfsSshTransport } from '@/lib/zfs/ssh-transport';
import { parseInfluxLine, type ZpoolStatsLine } from '@/lib/zfs/zpool-influxdb';
import { readZpoolStatus, type StatusPool } from '@/lib/zfs/zpool-status';
import { buildZfsSampleRows, ZfsCounterTracker } from '@/lib/zfs/zfs-sample';
import { abortableSleep } from '@/lib/utils/abortable-sleep';
import { BaseCollector } from './base-collector';

export const ZFS_SAMPLE_INTERVAL_MS = 1000;
export const ZFS_STATUS_EVERY_SAMPLES = 5;
/** A request that gets no answer for this long counts as hung: a suspended pool blocks zpool_influxdb in the kernel. */
export const ZFS_SAMPLE_TIMEOUT_MS = 10_000;
export const ZFS_CONNECT_TIMEOUT_MS = 10_000;
/** last_success_at is shown to the minute, so writing it on every sample would only add load. */
const SUCCESS_WRITE_INTERVAL_MS = 15_000;
const MAX_BUFFERED_TEXT = 1024 * 1024;

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

/**
 * One SSH session per node: a long-lived `zpool_influxdb --execd` channel asked once a second, and
 * `zpool status -j` every fifth sample on a second channel for the layout. Each node runs on its own
 * loop, so one that hangs never delays another.
 */
export class ZfsNodeCollector extends BaseCollector {
  readonly name: string;
  private readonly now: () => number;
  private readonly tick: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly loggedLines = new Set<string>();
  private lastSuccessWrite = 0;
  private lastRecordedOk = false;

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
        console.error(`[${this.name}] host key ${err.fingerprint ?? 'unknown'} does not match the confirmed key, collection stopped`);
        await this.recordFailure('host_key_changed', err.fingerprint);
        this.stop();
        return null;
      }
      await this.recordFailure(failureFromError(err));
      throw err;
    }
  }

  private logLineOnce(reason: string, line: string): void {
    if (this.loggedLines.has(reason) || this.loggedLines.size > 50) return;
    this.loggedLines.add(reason);
    console.error(`[${this.name}] skipping a zpool_influxdb line it cannot read (${reason}): ${line.slice(0, 200)}`);
  }

  protected async collect(): Promise<void> {
    const session = await this.connect();
    if (!session) return;

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
        if (code === DISPATCH_EXIT_MISSING) end(new ZfsNodeReadError('influxdb_missing', stderr.trim()));
        else if (code === null) end(new ZfsNodeReadError('unreachable', 'The zpool_influxdb channel closed without an exit status'));
        else end(new ZfsNodeReadError('error', `zpool_influxdb exited with ${code ?? 'no code'}: ${stderr.trim()}`));
      });

      const tracker = new ZfsCounterTracker();
      let layout: StatusPool[] | null = null;
      let statusInFlight = false;
      let pending: ZpoolStatsLine[] = [];
      let text = '';
      stream.onData((chunk) => {
        text += chunk;
        if (text.length > MAX_BUFFERED_TEXT) {
          end(new ZfsNodeReadError('error', 'zpool_influxdb printed a line longer than 1 MiB'));
          return;
        }
        const lines = text.split('\n');
        text = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() === '') continue;
          const parsed = parseInfluxLine(line);
          if (parsed.kind === 'stats') pending.push(parsed.line);
          else if (parsed.kind === 'malformed') this.logLineOnce(parsed.reason, line);
        }
      });

      const refreshLayout = async () => {
        statusInFlight = true;
        try {
          const result = await session.exec(ZFS_STATUS_COMMAND, ZFS_SAMPLE_TIMEOUT_MS);
          if (result.code !== 0) {
            end(new ZfsNodeReadError('error', `zpool status exited with ${result.code ?? 'no code'}: ${result.stderr.trim()}`));
            return;
          }
          layout = readZpoolStatus(result.stdout);
        } catch (err) {
          end(new ZfsNodeReadError(failureFromError(err), err instanceof Error ? err.message : String(err)));
        } finally {
          statusInFlight = false;
        }
      };

      let sample = 0;
      let requestedAt: number | null = null;
      while (!this.signal.aborted && !ended) {
        if (sample % ZFS_STATUS_EVERY_SAMPLES === 0 && !statusInFlight) void refreshLayout();
        sample++;

        if (requestedAt !== null) {
          const noPools = layout !== null && (layout as StatusPool[]).length === 0;
          if (pending.length > 0 || noPools) {
            const lines = pending;
            pending = [];
            requestedAt = null;
            await this.writeSample(lines, layout, tracker);
          } else if (this.now() - requestedAt >= ZFS_SAMPLE_TIMEOUT_MS) {
            end(new ZfsNodeReadError('timeout', `zpool_influxdb gave no answer for ${ZFS_SAMPLE_TIMEOUT_MS}ms`));
            break;
          }
        }
        if (requestedAt === null) {
          stream.write('\n');
          requestedAt = this.now();
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

  private async writeSample(lines: ZpoolStatsLine[], layout: StatusPool[] | null, tracker: ZfsCounterTracker): Promise<void> {
    const rows = buildZfsSampleRows({ host: this.node.name, time: new Date(this.now()), lines, layout, tracker });
    try {
      await this.deps.insertRows(rows);
    } catch (err) {
      console.error(`[${this.name}] writing ${rows.length} row(s) failed:`, err instanceof Error ? err.message : err);
      return;
    }
    this.resetBackoff();
    await this.recordSuccess();
  }
}

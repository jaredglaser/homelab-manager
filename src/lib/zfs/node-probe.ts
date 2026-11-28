import type { ZfsNodeFailure } from '@/lib/zfs/node-state';
import { DISPATCH_EXIT_MISSING, ZFS_INFLUXDB_COMMAND, ZFS_STATUS_COMMAND } from '@/lib/zfs/node-setup-script';
import { readZpoolStatus } from '@/lib/zfs/zpool-status';
import { parseInfluxLine } from '@/lib/zfs/zpool-influxdb';
import { ZfsSshError, type ZfsSshSession, type ZfsSshStream, type ZfsSshTarget, type ZfsSshTransport } from '@/lib/zfs/ssh-transport';

export const PROBE_TIMEOUT_MS = 10_000;
/** After the first zpool_stats line, a sample is taken as complete once output pauses this long. */
const SAMPLE_QUIET_MS = 300;

export function failureFromError(err: unknown): ZfsNodeFailure {
  if (!(err instanceof ZfsSshError)) return 'error';
  switch (err.kind) {
    case 'unreachable':
      return 'unreachable';
    case 'host_key':
      return 'host_key_changed';
    case 'key_refused':
      return 'key_refused';
    case 'timeout':
      return 'timeout';
    case 'error':
      return 'error';
  }
}

export type ScanResult = { ok: true; fingerprint: string } | { ok: false; failure: ZfsNodeFailure };

/** Reads the node's host key without authenticating, so nothing runs on a node whose key is not confirmed. */
export async function scanHostKey(transport: ZfsSshTransport, target: ZfsSshTarget): Promise<ScanResult> {
  try {
    const session = await transport.connect(target, { acceptHostKey: () => false, timeoutMs: PROBE_TIMEOUT_MS });
    session.close();
    return { ok: false, failure: 'error' };
  } catch (err) {
    if (err instanceof ZfsSshError && err.kind === 'host_key' && err.fingerprint !== null) {
      return { ok: true, fingerprint: err.fingerprint };
    }
    return { ok: false, failure: failureFromError(err) };
  }
}

export type VerifyResult =
  | { ok: true; pools: string[] }
  | { ok: false; failure: ZfsNodeFailure; fingerprint: string | null };

/** Resolves true once zpool_influxdb answers, false when it exits as missing. Throws a timeout when it hangs. */
function awaitInfluxAnswer(stream: ZfsSshStream, expectPools: boolean, quietMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let buffered = '';
    let sawStats = false;
    let done = false;
    const finish = (value: boolean | Error) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(quietTimer);
      stream.close();
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const deadline = setTimeout(() => {
      if (!expectPools) finish(true);
      else finish(new ZfsSshError('timeout', 'zpool_influxdb did not answer'));
    }, expectPools ? PROBE_TIMEOUT_MS : quietMs * 3);
    stream.onData((chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      if (lines.some((line) => parseInfluxLine(line).kind === 'stats')) sawStats = true;
      if (!sawStats) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), quietMs);
    });
    stream.onClose((code) => {
      if (code === DISPATCH_EXIT_MISSING) finish(false);
      else if (sawStats) finish(true);
      else finish(new ZfsSshError('error', `zpool_influxdb exited with ${code ?? 'no code'}`));
    });
    stream.write('\n');
  });
}

async function runBothReads(session: ZfsSshSession, quietMs: number): Promise<VerifyResult> {
  const status = await session.exec(ZFS_STATUS_COMMAND, PROBE_TIMEOUT_MS);
  if (status.code !== 0) {
    console.error(`[zfs-node-probe] zpool status exited with ${status.code}: ${status.stderr.trim()}`);
    return { ok: false, failure: 'error', fingerprint: null };
  }
  const pools = readZpoolStatus(status.stdout).map((pool) => pool.name);
  const stream = await session.stream(ZFS_INFLUXDB_COMMAND);
  const answered = await awaitInfluxAnswer(stream, pools.length > 0, quietMs);
  if (!answered) return { ok: false, failure: 'influxdb_missing', fingerprint: null };
  return { ok: true, pools };
}

/** Connects with the pinned key only and runs both reads once, for the verify step. */
export async function verifyNode(
  transport: ZfsSshTransport,
  target: ZfsSshTarget,
  pinnedFingerprint: string,
  quietMs = SAMPLE_QUIET_MS,
): Promise<VerifyResult> {
  let session: ZfsSshSession;
  try {
    session = await transport.connect(target, {
      acceptHostKey: (fingerprint) => fingerprint === pinnedFingerprint,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, failure: failureFromError(err), fingerprint: err instanceof ZfsSshError ? err.fingerprint : null };
  }
  try {
    return await runBothReads(session, quietMs);
  } catch (err) {
    console.error('[zfs-node-probe] reading the node failed:', err instanceof Error ? err.message : err);
    return { ok: false, failure: failureFromError(err), fingerprint: null };
  } finally {
    session.close();
  }
}

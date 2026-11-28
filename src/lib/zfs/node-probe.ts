import type { ZfsNodeFailure } from '@/lib/zfs/node-state';
import { DISPATCH_EXIT_MISSING, ZFS_INFLUXDB_COMMAND, ZFS_STATUS_COMMAND } from '@/lib/zfs/node-setup-script';
import { readZpoolStatus } from '@/lib/zfs/zpool-status';
import { parseInfluxLine } from '@/lib/zfs/zpool-influxdb';
import { MAX_EXEC_OUTPUT_BYTES, ZfsSshError, printableNodeText, realZfsTimer, type ZfsTimer, type ZfsSshSession, type ZfsSshStream, type ZfsSshTarget, type ZfsSshTransport } from '@/lib/zfs/ssh-transport';

export const PROBE_TIMEOUT_MS = 10_000;

export function failureFromError(err: unknown): ZfsNodeFailure {
  if (!(err instanceof ZfsSshError)) return 'error';
  switch (err.kind) {
    case 'unreachable':
      return 'unreachable';
    case 'host_key':
      return 'host_key_changed';
    case 'key_refused':
      return 'key_refused';
    case 'no_ed25519_key':
      return 'no_ed25519_key';
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

/** A node with no pools prints nothing, so a missing binary is ruled out once the channel stays open this long. */
const NO_POOLS_WAIT_MS = 1000;

/** Resolves true at the first zpool_stats line, false when zpool_influxdb exits as missing. Rejects on a hang or on output past the cap. */
function awaitInfluxAnswer(stream: ZfsSshStream, expectPools: boolean, timer: ZfsTimer): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let partial = '';
    let received = 0;
    let done = false;
    const finish = (value: boolean | Error) => {
      if (done) return;
      done = true;
      cancelDeadline();
      stream.close();
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const cancelDeadline = timer(() => {
      if (expectPools) finish(new ZfsSshError('timeout', 'zpool_influxdb did not answer'));
      else finish(true);
    }, expectPools ? PROBE_TIMEOUT_MS : NO_POOLS_WAIT_MS);
    stream.onData((chunk) => {
      received += chunk.length;
      if (received > MAX_EXEC_OUTPUT_BYTES) {
        finish(new ZfsSshError('error', `zpool_influxdb printed more than ${MAX_EXEC_OUTPUT_BYTES} bytes before a sample`));
        return;
      }
      partial += chunk;
      let newline = partial.indexOf('\n');
      while (newline !== -1) {
        const line = partial.slice(0, newline);
        partial = partial.slice(newline + 1);
        if (parseInfluxLine(line).kind === 'stats') {
          finish(true);
          return;
        }
        newline = partial.indexOf('\n');
      }
    });
    stream.onClose((code) => {
      if (code === DISPATCH_EXIT_MISSING) finish(false);
      else finish(new ZfsSshError('error', `zpool_influxdb exited with ${code ?? 'no code'}`));
    });
    stream.write('\n');
  });
}

async function runBothReads(session: ZfsSshSession, timer: ZfsTimer): Promise<VerifyResult> {
  const status = await session.exec(ZFS_STATUS_COMMAND, PROBE_TIMEOUT_MS);
  if (status.code !== 0) {
    console.error(`[zfs-node-probe] zpool status exited with ${status.code}: ${printableNodeText(status.stderr.trim())}`);
    return { ok: false, failure: 'error', fingerprint: null };
  }
  const pools = readZpoolStatus(status.stdout).map((pool) => pool.name);
  const stream = await session.stream(ZFS_INFLUXDB_COMMAND);
  const answered = await awaitInfluxAnswer(stream, pools.length > 0, timer);
  if (!answered) return { ok: false, failure: 'influxdb_missing', fingerprint: null };
  return { ok: true, pools };
}

/** Connects with the pinned key only and runs both reads once, for the verify step. */
export async function verifyNode(
  transport: ZfsSshTransport,
  target: ZfsSshTarget,
  pinnedFingerprint: string,
  timer: ZfsTimer = realZfsTimer,
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
    return await runBothReads(session, timer);
  } catch (err) {
    console.error('[zfs-node-probe] reading the node failed:', printableNodeText(err instanceof Error ? err.message : String(err)));
    return { ok: false, failure: failureFromError(err), fingerprint: null };
  } finally {
    session.close();
  }
}

import { createHash } from 'node:crypto';
import type { ClientChannel, ConnectConfig } from 'ssh2';

export interface ZfsSshTarget {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

export type ZfsSshFailureKind = 'unreachable' | 'host_key' | 'key_refused' | 'timeout' | 'error';

export class ZfsSshError extends Error {
  constructor(
    readonly kind: ZfsSshFailureKind,
    message: string,
    /** The fingerprint the node presented, when the failure is about it. */
    readonly fingerprint: string | null = null,
  ) {
    super(message);
    this.name = 'ZfsSshError';
  }
}

export interface ZfsExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A long-lived command channel: stdin is written, stdout arrives as text. */
export interface ZfsSshStream {
  write(data: string): void;
  onData(listener: (chunk: string) => void): void;
  /** Called once when the command exits or the channel closes, with the exit code if one arrived. */
  onClose(listener: (code: number | null, stderr: string) => void): void;
  close(): void;
}

/** zpool status for a large pool is tens of KiB. Anything past this is not output the dispatcher produces. */
export const MAX_EXEC_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Not one of the dispatcher's two commands, so it answers at once without touching ZFS. */
export const LIVENESS_COMMAND = 'homelab-manager-liveness';

export interface ZfsSshSession {
  /** `timeoutMs` null waits for the command however long it takes. */
  exec(command: string, timeoutMs: number | null): Promise<ZfsExecResult>;
  /** True when the node answers a command within `timeoutMs`, which tells a live session from a dead one. */
  isResponsive(timeoutMs: number): Promise<boolean>;
  stream(command: string): Promise<ZfsSshStream>;
  /** Called once when the connection drops or is closed. */
  onClose(listener: () => void): void;
  close(): void;
}

export interface ZfsSshConnectOptions {
  /** Return true to trust the presented key. Returning false ends the handshake before authentication. */
  acceptHostKey: (fingerprint: string) => boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ZfsSshTransport {
  connect(target: ZfsSshTarget, options: ZfsSshConnectOptions): Promise<ZfsSshSession>;
}

/** OpenSSH's SHA256 fingerprint of a raw host key blob, as `ssh-keygen -lf` prints it. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** ssh2 keepalives, unrelated to the mux cadence: a dead node is noticed after three misses, 30 seconds. */
const SSH_LIVENESS_PROBE_MS = 10_000;
const SSH_LIVENESS_MISSES = 3;

const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE']);

export function classifyConnectError(err: unknown): ZfsSshFailureKind {
  const level = (err as { level?: string }).level;
  const code = (err as { code?: string }).code;
  if (level === 'client-authentication') return 'key_refused';
  if (level === 'client-timeout' || level === 'client-socket') return 'unreachable';
  if (code !== undefined && UNREACHABLE_CODES.has(code)) return 'unreachable';
  return 'error';
}

function channelSession(channel: ClientChannel): ZfsSshStream {
  channel.setEncoding('utf8');
  channel.stderr.setEncoding('utf8');
  let stderr = '';
  let exitCode: number | null = null;
  const closeListeners: ((code: number | null, stderr: string) => void)[] = [];
  let closed = false;
  channel.stderr.on('data', (chunk: string) => {
    if (stderr.length < 4096) stderr += chunk;
  });
  channel.on('exit', (code: number | null) => {
    exitCode = typeof code === 'number' ? code : null;
  });
  channel.on('close', () => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener(exitCode, stderr);
  });
  return {
    write: (data) => {
      if (!closed) channel.write(data);
    },
    onData: (listener) => {
      channel.on('data', listener);
    },
    onClose: (listener) => {
      if (closed) listener(exitCode, stderr);
      else closeListeners.push(listener);
    },
    close: () => {
      if (!closed) channel.close();
    },
  };
}

/** The ssh2 transport. Only the ed25519 host key is negotiated, so the fingerprint matches the one the setup script prints. */
export function createSsh2Transport(): ZfsSshTransport {
  return {
    async connect(target, { acceptHostKey, timeoutMs, signal }) {
      const { Client } = await import('ssh2');
      return new Promise<ZfsSshSession>((resolve, reject) => {
        const client = new Client();
        let presented: string | null = null;
        let rejectedKey = false;
        let settled = false;
        let closed = false;
        const closeListeners: (() => void)[] = [];

        const fail = (error: ZfsSshError) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          client.end();
          reject(error);
        };
        const onAbort = () => fail(new ZfsSshError('error', 'Connection cancelled'));
        if (signal?.aborted) {
          reject(new ZfsSshError('error', 'Connection cancelled'));
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        client.on('error', (err: Error) => {
          if (rejectedKey) {
            fail(new ZfsSshError('host_key', 'The node presented a host key that is not confirmed', presented));
            return;
          }
          fail(new ZfsSshError(classifyConnectError(err), err.message));
        });
        client.on('close', () => {
          if (!settled) {
            fail(rejectedKey
              ? new ZfsSshError('host_key', 'The node presented a host key that is not confirmed', presented)
              : new ZfsSshError('unreachable', 'The connection closed before it was ready'));
            return;
          }
          if (closed) return;
          closed = true;
          for (const listener of closeListeners) listener();
        });
        client.on('ready', () => {
          if (settled) {
            client.end();
            return;
          }
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve({
            exec: (command, execTimeoutMs) => new Promise<ZfsExecResult>((resolveExec, rejectExec) => {
              client.exec(command, (err, channel) => {
                if (err) {
                  rejectExec(new ZfsSshError('error', err.message));
                  return;
                }
                const stream = channelSession(channel);
                let stdout = '';
                let failed = false;
                const timer = execTimeoutMs === null ? undefined : setTimeout(() => {
                  failed = true;
                  stream.close();
                  rejectExec(new ZfsSshError('timeout', `${command} did not finish within ${execTimeoutMs}ms`));
                }, execTimeoutMs);
                stream.onData((chunk) => {
                  if (failed) return;
                  stdout += chunk;
                  if (stdout.length > MAX_EXEC_OUTPUT_BYTES) {
                    failed = true;
                    clearTimeout(timer);
                    stream.close();
                    rejectExec(new ZfsSshError('error', `${command} printed more than ${MAX_EXEC_OUTPUT_BYTES} bytes`));
                  }
                });
                stream.onClose((code, stderr) => {
                  clearTimeout(timer);
                  if (!failed) resolveExec({ code, stdout, stderr });
                });
              });
            }),
            isResponsive: (probeTimeoutMs) => new Promise<boolean>((resolveProbe) => {
              const timer = setTimeout(() => resolveProbe(false), probeTimeoutMs);
              try {
                client.exec(LIVENESS_COMMAND, (err, channel) => {
                  if (err) {
                    clearTimeout(timer);
                    resolveProbe(false);
                    return;
                  }
                  const probe = channelSession(channel);
                  probe.onData(() => {});
                  probe.onClose(() => {
                    clearTimeout(timer);
                    resolveProbe(true);
                  });
                });
              } catch {
                clearTimeout(timer);
                resolveProbe(false);
              }
            }),
            stream: (command) => new Promise<ZfsSshStream>((resolveStream, rejectStream) => {
              client.exec(command, (err, channel) => {
                if (err) rejectStream(new ZfsSshError('error', err.message));
                else resolveStream(channelSession(channel));
              });
            }),
            onClose: (listener) => {
              if (closed) listener();
              else closeListeners.push(listener);
            },
            close: () => client.end(),
          });
        });

        const config: ConnectConfig = {
          host: target.host,
          port: target.port,
          username: target.username,
          privateKey: target.privateKey,
          readyTimeout: timeoutMs,
          keepaliveInterval: SSH_LIVENESS_PROBE_MS,
          keepaliveCountMax: SSH_LIVENESS_MISSES,
          algorithms: { serverHostKey: ['ssh-ed25519'] },
          hostVerifier: (key: Buffer) => {
            presented = hostKeyFingerprint(key);
            const accepted = acceptHostKey(presented);
            rejectedKey = !accepted;
            return accepted;
          },
        };
        client.connect(config);
      });
    },
  };
}

/** Node output goes to the worker log, so terminal escapes and carriage returns in it must not reach the terminal. */
export function printableNodeText(text: string, maxLength = 500): string {
  return text
    .replaceAll(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?')
    .slice(0, maxLength);
}

import { createHash } from 'node:crypto';
import type { ClientChannel, ConnectConfig, ServerHostKeyAlgorithm } from 'ssh2';

/** Schedules `fn` after `ms` and returns its cancel. Tests pass one they control. */
export type ZfsTimer = (fn: () => void, ms: number) => () => void;

export const realZfsTimer: ZfsTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export interface ZfsSshTarget {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

export type ZfsSshFailureKind = 'unreachable' | 'host_key' | 'no_ed25519_key' | 'key_refused' | 'timeout' | 'error';

export class ZfsSshError extends Error {
  constructor(
    readonly kind: ZfsSshFailureKind,
    message: string,
    /** The fingerprint the node presented, when the failure is about it. */
    readonly fingerprint: string | null = null,
  ) {
    super(printableNodeText(message));
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

/** The key type a raw host key blob starts with, such as `ssh-ed25519`. */
export function hostKeyType(key: Buffer): string | null {
  if (key.length < 4) return null;
  const length = key.readUInt32BE(0);
  if (length > 64 || key.length < 4 + length) return null;
  return key.subarray(4, 4 + length).toString('latin1');
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
/**
 * ed25519 first, so a node that has one always negotiates it. The others are offered only so a node
 * without one shows its key type, which is refused, instead of failing the handshake like any mismatch.
 */
const HOST_KEY_PREFERENCE: ServerHostKeyAlgorithm[] = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'];

export function createSsh2Transport(timer: ZfsTimer = realZfsTimer): ZfsSshTransport {
  return {
    async connect(target, { acceptHostKey, timeoutMs, signal }) {
      const { Client } = await import('ssh2');
      return new Promise<ZfsSshSession>((resolve, reject) => {
        const client = new Client();
        let presented: string | null = null;
        let rejectedKind: 'host_key' | 'no_ed25519_key' | null = null;
        const rejectedError = () => rejectedKind === 'no_ed25519_key'
          ? new ZfsSshError('no_ed25519_key', 'The node offered no ed25519 host key', presented)
          : new ZfsSshError('host_key', 'The node presented a host key that is not confirmed', presented);
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
          if (rejectedKind) {
            fail(rejectedError());
            return;
          }
          fail(new ZfsSshError(classifyConnectError(err), printableNodeText(err.message)));
        });
        client.on('close', () => {
          if (!settled) {
            fail(rejectedKind ? rejectedError() : new ZfsSshError('unreachable', 'The connection closed before it was ready'));
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
                  rejectExec(new ZfsSshError('error', printableNodeText(err.message)));
                  return;
                }
                const stream = channelSession(channel);
                let stdout = '';
                let failed = false;
                const cancelTimeout = execTimeoutMs === null ? () => {} : timer(() => {
                  failed = true;
                  stream.close();
                  rejectExec(new ZfsSshError('timeout', `${command} did not finish within ${execTimeoutMs}ms`));
                }, execTimeoutMs);
                stream.onData((chunk) => {
                  if (failed) return;
                  stdout += chunk;
                  if (stdout.length > MAX_EXEC_OUTPUT_BYTES) {
                    failed = true;
                    cancelTimeout();
                    stream.close();
                    rejectExec(new ZfsSshError('error', `${command} printed more than ${MAX_EXEC_OUTPUT_BYTES} bytes`));
                  }
                });
                stream.onClose((code, stderr) => {
                  cancelTimeout();
                  if (!failed) resolveExec({ code, stdout, stderr });
                });
              });
            }),
            isResponsive: (probeTimeoutMs) => new Promise<boolean>((resolveProbe) => {
              const cancelProbe = timer(() => resolveProbe(false), probeTimeoutMs);
              const answer = (alive: boolean) => {
                cancelProbe();
                resolveProbe(alive);
              };
              try {
                client.exec(LIVENESS_COMMAND, (err, channel) => {
                  if (err) {
                    answer(false);
                    return;
                  }
                  const probe = channelSession(channel);
                  probe.onData(() => {});
                  probe.onClose(() => answer(true));
                });
              } catch {
                answer(false);
              }
            }),
            stream: (command) => new Promise<ZfsSshStream>((resolveStream, rejectStream) => {
              client.exec(command, (err, channel) => {
                if (err) rejectStream(new ZfsSshError('error', printableNodeText(err.message)));
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
          algorithms: { serverHostKey: HOST_KEY_PREFERENCE },
          hostVerifier: (key: Buffer) => {
            presented = hostKeyFingerprint(key);
            if (hostKeyType(key) !== 'ssh-ed25519') {
              rejectedKind = 'no_ed25519_key';
              return false;
            }
            const accepted = acceptHostKey(presented);
            rejectedKind = accepted ? null : 'host_key';
            return accepted;
          },
        };
        client.connect(config);
      });
    },
  };
}

const INVISIBLE_FORMAT = /[\p{Cf}\p{Zl}\p{Zp}]/u;

/** Node and network text goes to the worker log, so escapes, line breaks and invisible or bidi controls in it must not reach the terminal. */
export function printableNodeText(text: string, maxLength = 500): string {
  let out = '';
  const chars = [...text];
  for (let i = 0; i < chars.length && out.length < maxLength; i++) {
    const char = chars[i];
    const code = char.codePointAt(0)!;
    if (code === 0x1b && chars[i + 1] === '[') {
      i += 2;
      while (i < chars.length && !(chars[i].charCodeAt(0) >= 0x40 && chars[i].charCodeAt(0) <= 0x7e)) i++;
      continue;
    }
    const control = code < 0x20 && code !== 0x09;
    const deleteOrC1 = code === 0x7f || (code >= 0x80 && code <= 0x9f);
    out += control || deleteOrC1 || INVISIBLE_FORMAT.test(char) ? '?' : char;
  }
  return out;
}

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server, utils, type ServerChannel } from 'ssh2';
import { ZFS_INFLUXDB_COMMAND, ZFS_STATUS_COMMAND } from '../node-setup-script';
import { ZfsSshError, classifyConnectError, createSsh2Transport, hostKeyFingerprint, type ZfsSshSession } from '../ssh-transport';

const hostKey = utils.generateKeyPairSync('ed25519');
const clientKey = utils.generateKeyPairSync('ed25519');
const strangerKey = utils.generateKeyPairSync('ed25519');
const allowed = utils.parseKey(clientKey.public);
if (allowed instanceof Error) throw allowed;
const parsedHost = utils.parseKey(hostKey.private);
if (parsedHost instanceof Error) throw parsedHost;
const HOST_FINGERPRINT = `SHA256:${createHash('sha256').update(parsedHost.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;

let server: Server;
let port: number;
const openChannels = new Set<ServerChannel>();

function handleExec(command: string, channel: ServerChannel): void {
  openChannels.add(channel);
  channel.on('close', () => openChannels.delete(channel));
  if (command === ZFS_STATUS_COMMAND) {
    channel.write('{"pools":{}}');
    channel.exit(0);
    channel.end();
    return;
  }
  if (command === ZFS_INFLUXDB_COMMAND) {
    let n = 0;
    channel.on('data', (data: Buffer) => {
      for (const char of data.toString()) {
        if (char === '\n') channel.write(`sample ${n++}\n`);
      }
    });
    return;
  }
  if (command === 'hang') return;
  channel.stderr.write('refused\n');
  channel.exit(126);
  channel.end();
}

beforeAll(async () => {
  server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
      const offered = ctx.key.data;
      const expected = allowed.getPublicSSH();
      if (ctx.key.algo !== allowed.type || offered.length !== expected.length || !timingSafeEqual(offered, expected)) return ctx.reject(['publickey']);
      if (ctx.signature && ctx.blob && allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(['publickey']);
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => handleExec(info.command, acceptExec()));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

const transport = createSsh2Transport();
const target = () => ({ host: '127.0.0.1', port, username: 'hlm', privateKey: clientKey.private });
const trustPinned = { acceptHostKey: (fingerprint: string) => fingerprint === HOST_FINGERPRINT, timeoutMs: 1500 };

async function failure(promise: Promise<unknown>): Promise<ZfsSshError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ZfsSshError) return err;
    throw err;
  }
  throw new Error('expected the call to fail');
}

describe('ssh2 transport', () => {
  test('prints the fingerprint the way ssh-keygen -l does', () => {
    expect(hostKeyFingerprint(parsedHost.getPublicSSH())).toBe(HOST_FINGERPRINT);
  });

  test('reports the presented host key and does not log in when it is not accepted', async () => {
    const error = await failure(transport.connect(target(), { acceptHostKey: () => false, timeoutMs: 1500 }));
    expect(error.kind).toBe('host_key');
    expect(error.fingerprint).toBe(HOST_FINGERPRINT);
  });

  test('runs the status read and returns its output and exit status', async () => {
    const session = await transport.connect(target(), trustPinned);
    expect(await session.exec(ZFS_STATUS_COMMAND, 1000)).toEqual({ code: 0, stdout: '{"pools":{}}', stderr: '' });
    expect(await session.exec('id', 1000)).toEqual({ code: 126, stdout: '', stderr: 'refused\n' });
    session.close();
  });

  test('keeps the zpool_influxdb channel open and answers each newline', async () => {
    const session = await transport.connect(target(), trustPinned);
    const stream = await session.stream(ZFS_INFLUXDB_COMMAND);
    const received: string[] = [];
    const twoSamples = new Promise<void>((resolve) => {
      stream.onData((chunk) => {
        received.push(chunk);
        if (received.join('').split('\n').length > 2) resolve();
      });
    });
    stream.write('\n');
    stream.write('\n');
    await twoSamples;
    expect(received.join('')).toBe('sample 0\nsample 1\n');
    const closed = new Promise<number | null>((resolve) => stream.onClose((code) => resolve(code)));
    stream.close();
    expect(await closed).toBeNull();
    session.close();
  });

  test('times out a command that never finishes', async () => {
    const session = await transport.connect(target(), trustPinned);
    const error = await failure(session.exec('hang', 50));
    expect(error.kind).toBe('timeout');
    session.close();
  });

  test('tells the caller when the connection drops', async () => {
    const session: ZfsSshSession = await transport.connect(target(), trustPinned);
    const dropped = new Promise<void>((resolve) => session.onClose(resolve));
    session.close();
    await dropped;
    const lateListener = new Promise<void>((resolve) => session.onClose(resolve));
    await lateListener;
  });

  test('reports a key the node refuses', async () => {
    const error = await failure(transport.connect({ ...target(), privateKey: strangerKey.private }, trustPinned));
    expect(error.kind).toBe('key_refused');
  });

  test('reports a node that refuses the connection as unreachable', async () => {
    const closed = new Server({ hostKeys: [hostKey.private] }, () => {});
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', () => resolve()));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const error = await failure(transport.connect({ ...target(), port: closedPort }, trustPinned));
    expect(error.kind).toBe('unreachable');
  });

  test('does not connect when already cancelled, and stops when cancelled mid-handshake', async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect((await failure(transport.connect(target(), { ...trustPinned, signal: aborted.signal }))).kind).toBe('error');

    const controller = new AbortController();
    const pending = transport.connect(target(), {
      acceptHostKey: () => {
        controller.abort();
        return true;
      },
      timeoutMs: 1500,
      signal: controller.signal,
    });
    expect((await failure(pending)).message).toBe('Connection cancelled');
  });

  test('classifies connection errors by level and code', () => {
    expect(classifyConnectError({ level: 'client-authentication' })).toBe('key_refused');
    expect(classifyConnectError({ level: 'client-timeout' })).toBe('unreachable');
    expect(classifyConnectError({ code: 'ENOTFOUND' })).toBe('unreachable');
    expect(classifyConnectError({ code: 'EHOSTUNREACH' })).toBe('unreachable');
    expect(classifyConnectError(new Error('protocol'))).toBe('error');
  });
});

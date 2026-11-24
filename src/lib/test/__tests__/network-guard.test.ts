import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { TCPSocketListener, UnixSocketListener } from 'bun';
import dns, { lookup as lookupCallback } from 'node:dns';
import { lookup as lookupPromise } from 'node:dns/promises';
import * as dnsPromises from 'node:dns/promises';
import http from 'node:http';
import { request as httpsRequest } from 'node:https';
import net from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { drainBlockedNetworkCalls, isLoopbackHost } from '../network-guard';
import { getTestTmpDir } from '../tmp-dir';

const HOST = 'guard-probe.example.com';

async function blockedError(call: () => unknown): Promise<{ error: Error; elapsed: number }> {
  const started = performance.now();
  try {
    await call();
  } catch (error) {
    return { error: error as Error, elapsed: performance.now() - started };
  }
  throw new Error('call was not blocked');
}

async function expectBlocked(api: string, call: () => unknown, fix: RegExp): Promise<void> {
  const { error, elapsed } = await blockedError(call);
  expect(error.name).toBe('NetworkGuardError');
  expect(error.message).toContain(`${api} tried to reach "${HOST}"`);
  expect(error.message).toMatch(fix);
  expect(elapsed).toBeLessThan(100);
  expect(drainBlockedNetworkCalls()).toEqual([error.message]);
}

const INJECT_RESOLVER = /Inject the resolver into the code under test, or (mock|stub) it/;
const INJECT_CLIENT = /Inject .+ into the code under test, or (mock|stub|replace) /;

describe('DNS from a unit test', () => {
  test('node:dns callback lookup', async () => {
    await expectBlocked('node:dns lookup', () => lookupCallback(HOST, () => undefined), INJECT_RESOLVER);
    await expectBlocked('node:dns lookup', () => dns.lookup(HOST, () => undefined), INJECT_RESOLVER);
  });

  test('node:dns/promises named import', async () => {
    await expectBlocked('node:dns/promises lookup', () => lookupPromise(HOST), INJECT_RESOLVER);
  });

  test('node:dns/promises namespace import', async () => {
    await expectBlocked('node:dns/promises lookup', () => dnsPromises.lookup(HOST), INJECT_RESOLVER);
  });

  test('node:dns resolve always reaches a DNS server, even for localhost', async () => {
    const { error } = await blockedError(() => dnsPromises.resolve4('localhost'));
    expect(error.message).toContain('node:dns/promises resolve4 tried to reach "localhost"');
    drainBlockedNetworkCalls();
  });

  test('Bun.dns.lookup', async () => {
    await expectBlocked('Bun.dns.lookup', () => Bun.dns.lookup(HOST), INJECT_RESOLVER);
  });

  test('a loopback name still resolves', async () => {
    const { address } = await lookupPromise('127.0.0.1');
    expect(address).toBe('127.0.0.1');
  });
});

describe('connections from a unit test', () => {
  test('global fetch with a string, a URL and a Request', async () => {
    await expectBlocked('fetch', () => fetch(`https://${HOST}/x`), INJECT_CLIENT);
    await expectBlocked('fetch', () => fetch(new URL(`http://${HOST}:8080/`)), INJECT_CLIENT);
    await expectBlocked('fetch', () => fetch(new Request(`https://${HOST}/`)), INJECT_CLIENT);
  });

  test('a host that only starts with a loopback address', async () => {
    const { error } = await blockedError(() => fetch('http://127.0.0.1.evil.com/'));
    expect(error.message).toContain('fetch tried to reach "127.0.0.1.evil.com"');
    drainBlockedNetworkCalls();
  });

  test('a relative URL is left to fetch to reject', async () => {
    const { error } = await blockedError(() => fetch('/api/health'));
    expect(error.name).not.toBe('NetworkGuardError');
    expect(drainBlockedNetworkCalls()).toEqual([]);
  });

  test('WebSocket', async () => {
    await expectBlocked('WebSocket', () => new WebSocket(`wss://${HOST}/api/mux`), INJECT_CLIENT);
  });

  test('node:http and node:https requests', async () => {
    await expectBlocked('node:http request', () => http.request(`http://${HOST}/`), INJECT_CLIENT);
    await expectBlocked('node:http get', () => http.get({ hostname: HOST, path: '/' }), INJECT_CLIENT);
    await expectBlocked('node:https request', () => httpsRequest({ host: HOST, port: 443 }), INJECT_CLIENT);
  });

  test('node:net and node:tls sockets', async () => {
    await expectBlocked('node:net connect', () => net.connect(80, HOST), INJECT_CLIENT);
    await expectBlocked('node:net createConnection', () => net.createConnection({ host: HOST, port: 80 }), INJECT_CLIENT);
    await expectBlocked('node:tls connect', () => tlsConnect({ host: HOST, port: 443 }), INJECT_CLIENT);
  });

  test('Bun.connect', async () => {
    await expectBlocked('Bun.connect', () => Bun.connect({ hostname: HOST, port: 80, socket: { data: () => undefined } }), INJECT_CLIENT);
  });

  test('restoring a fetch spy brings back the guarded fetch', async () => {
    const guarded = globalThis.fetch;
    const spy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('stubbed'));
    expect(await (await fetch(`https://${HOST}/`)).text()).toBe('stubbed');
    spy.mockRestore();
    expect(globalThis.fetch).toBe(guarded);
    await expectBlocked('fetch', () => fetch(`https://${HOST}/`), INJECT_CLIENT);
  });
});

describe('loopback and unix sockets', () => {
  const answer: Parameters<typeof Bun.listen>[0]['socket'] = {
    data(socket) {
      socket.end('HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 8\r\nConnection: close\r\n\r\nloopback');
    },
  };
  let server: TCPSocketListener;
  let unixServer: UnixSocketListener<unknown>;
  let socketDir: string;
  let socketPath: string;

  beforeAll(() => {
    server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: answer });
    socketDir = mkdtempSync(join(getTestTmpDir(), 'network-guard-'));
    socketPath = join(socketDir, 'guard.sock');
    unixServer = Bun.listen({ unix: socketPath, socket: answer });
  });

  afterAll(() => {
    server.stop(true);
    unixServer.stop(true);
    rmSync(socketDir, { recursive: true, force: true });
  });

  test.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.2', '0.0.0.0', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1'])(
    '%s counts as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  test.each(['127.0.0.1.evil.com', 'localhost.evil.com', '10.0.0.1', '128.0.0.1', '::2', 'example.com'])(
    '%s does not count as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );

  test('fetch reaches a real server on 127.0.0.1', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(await response.text()).toBe('loopback');
  });

  test('node:net connects to 127.0.0.1', async () => {
    const socket = net.connect(server.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.destroy();
  });

  test('node:http reaches a unix socket', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get({ socketPath, path: '/' }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
    expect(body).toBe('loopback');
  });
});

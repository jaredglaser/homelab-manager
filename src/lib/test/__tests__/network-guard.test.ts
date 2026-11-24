import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { TCPSocketListener, UnixSocketListener } from 'bun';
import dns, { lookup as lookupCallback } from 'node:dns';
import { lookup as lookupPromise } from 'node:dns/promises';
import * as dnsPromises from 'node:dns/promises';
import http from 'node:http';
import { request as httpsRequest } from 'node:https';
import net from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import pg from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { drainBlockedNetworkCalls, isLoopbackHost, NetworkGuardError } from '../network-guard';
import { getTestTmpDir } from '../tmp-dir';

const HOST = 'guard-probe.invalid';
const IP = '192.0.2.1';
type UntypedBunDns = Record<'lookupService' | 'resolve' | 'reverse', (...args: unknown[]) => Promise<unknown>>;
const bunDns = Bun.dns as typeof Bun.dns & UntypedBunDns;

async function blockedError(call: () => unknown): Promise<{ error: Error }> {
  try {
    await call();
  } catch (error) {
    return { error: error as Error };
  }
  throw new Error('call was not blocked');
}

async function expectBlocked(api: string, call: () => unknown, fix: RegExp, host = HOST): Promise<void> {
  const { error } = await blockedError(call);
  expect(error.name).toBe('NetworkGuardError');
  expect(error.message).toContain(`${api} tried to reach "${host}"`);
  expect(error.message).toMatch(fix);
  const calls = drainBlockedNetworkCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toStartWith(`${error.message}\n`);
  const stack = calls[0].slice(error.message.length + 1);
  expect(stack).toContain('network-guard.test.ts');
  expect(stack).not.toContain('network-guard.ts:');
}

async function expectRejected(api: string, call: () => Promise<unknown>, host = HOST): Promise<void> {
  let pending: Promise<unknown> | undefined;
  expect(() => {
    pending = call();
  }).not.toThrow();
  const error: unknown = await pending?.catch((rejection: unknown) => rejection);
  expect(error).toBeInstanceOf(NetworkGuardError);
  expect((error as Error).message).toContain(`${api} tried to reach "${host}"`);
  expect(drainBlockedNetworkCalls()).toHaveLength(1);
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

  test('dns Resolver instances', async () => {
    await expectBlocked('node:dns resolve4', () => new dns.Resolver().resolve4(HOST, () => undefined), INJECT_RESOLVER);
    await expectBlocked('node:dns/promises resolve4', () => new dnsPromises.Resolver().resolve4(HOST), INJECT_RESOLVER);
  });

  test('node:dns lookupService and reverse', async () => {
    await expectBlocked('node:dns lookupService', () => dns.lookupService(IP, 80, () => undefined), INJECT_RESOLVER, IP);
    await expectBlocked('node:dns reverse', () => dns.reverse(IP, () => undefined), INJECT_RESOLVER, IP);
  });

  test('node:dns/promises rejects instead of throwing', async () => {
    await expectRejected('node:dns/promises lookup', () => lookupPromise(HOST));
    await expectRejected('node:dns/promises reverse', () => dnsPromises.reverse(IP), IP);
  });

  test('Bun.dns', async () => {
    await expectBlocked('Bun.dns.lookup', () => Bun.dns.lookup(HOST), INJECT_RESOLVER);
    await expectBlocked('Bun.dns.prefetch', () => Bun.dns.prefetch(HOST), INJECT_RESOLVER);
    await expectBlocked('Bun.dns.lookupService', () => bunDns.lookupService(IP, 80), INJECT_RESOLVER, IP);
    await expectBlocked('Bun.dns.resolve', () => bunDns.resolve(HOST), INJECT_RESOLVER);
    await expectBlocked('Bun.dns.reverse', () => bunDns.reverse(IP), INJECT_RESOLVER, IP);
    await expectRejected('Bun.dns.lookup', () => Bun.dns.lookup(HOST));
  });

  test('a loopback name still resolves', async () => {
    const { address } = await lookupPromise('localhost');
    expect(isLoopbackHost(address)).toBe(true);
  });
});

describe('connections from a unit test', () => {
  test('global fetch with a string, a URL and a Request', async () => {
    await expectBlocked('fetch', () => fetch(`https://${HOST}/x`), INJECT_CLIENT);
    await expectBlocked('fetch', () => fetch(new URL(`http://${HOST}:8080/`)), INJECT_CLIENT);
    await expectBlocked('fetch', () => fetch(new Request(`https://${HOST}/`)), INJECT_CLIENT);
  });

  test('a host that only starts with a loopback address', async () => {
    const { error } = await blockedError(() => fetch('http://127.0.0.1.guard.invalid/'));
    expect(error.message).toContain('fetch tried to reach "127.0.0.1.guard.invalid"');
    drainBlockedNetworkCalls();
  });

  test('a remote proxy is blocked even for a loopback URL', async () => {
    await expectBlocked('fetch', () => fetch('http://127.0.0.1:9/', { proxy: `http://${IP}:3128` } as RequestInit), INJECT_CLIENT, IP);
  });

  test('a file: URL with a host is left to fetch to reject', async () => {
    const { error } = await blockedError(() => fetch(`file://${HOST}/etc/hostname`));
    expect(error.name).not.toBe('NetworkGuardError');
    expect(drainBlockedNetworkCalls()).toEqual([]);
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

  test('connections to an IP address', async () => {
    await expectBlocked('node:net Socket.connect', () => new net.Socket().connect(9, IP), INJECT_CLIENT, IP);
    await expectBlocked('node:http request', () => http.request(`http://${IP}:9/`), INJECT_CLIENT, IP);
    await expectBlocked('node:net createConnection', () => new http.ClientRequest(`http://${IP}:9/`), INJECT_CLIENT, IP);
    await expectBlocked('node:net Socket.connect', () => new pg.Client({ host: IP, port: 9 }).connect(), INJECT_CLIENT, IP);
  });

  test('empty and null options do not hide the host', async () => {
    await expectBlocked('node:http request', () => http.request({ hostname: '', host: IP }), INJECT_CLIENT, IP);
    await expectBlocked('node:http request', () => http.request({ hostname: IP, host: 'localhost' }), INJECT_CLIENT, IP);
    await expectBlocked('node:http request', () => http.request({ socketPath: null, host: IP } as unknown as http.RequestOptions), INJECT_CLIENT, IP);
    await expectBlocked('node:net connect', () => net.connect({ host: IP, port: 9, path: null } as unknown as net.NetConnectOpts), INJECT_CLIENT, IP);
    const socket = { data: () => undefined };
    await expectBlocked('Bun.connect', () => Bun.connect({ host: IP, port: 9, socket } as unknown as Parameters<typeof Bun.connect>[0]), INJECT_CLIENT, IP);
    await expectBlocked('Bun.connect', () => Bun.connect({ hostname: IP, port: 9, unix: '', socket } as unknown as Parameters<typeof Bun.connect>[0]), INJECT_CLIENT, IP);
  });

  test('a stack that is not a string still records the call', async () => {
    const original = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    Error.prepareStackTrace = (_error, callSites) => callSites;
    try {
      const { error } = await blockedError(() => dns.lookup(HOST, () => undefined));
      expect(error.name).toBe('NetworkGuardError');
    } finally {
      // Bun keeps formatting stacks as CallSite arrays if the native formatter is put straight back.
      Reflect.set(Error, 'prepareStackTrace', undefined);
      if (original) Object.defineProperty(Error, 'prepareStackTrace', original);
    }
    expect(drainBlockedNetworkCalls()).toHaveLength(1);
  });

  test('an IPv6 zone ID does not hide the host', async () => {
    await expectBlocked('node:net connect', () => net.connect(9, 'fe80::1%eth0'), INJECT_CLIENT, 'fe80::1%eth0');
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
  let unixServer: UnixSocketListener<unknown> | undefined;
  let socketDir: string | undefined;
  let socketPath: string;

  beforeAll(() => {
    server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: answer });
    socketDir = mkdtempSync(join(getTestTmpDir(), 'network-guard-'));
    socketPath = join(socketDir, 'guard.sock');
    unixServer = Bun.listen({ unix: socketPath, socket: answer });
  });

  afterAll(() => {
    server.stop(true);
    unixServer?.stop(true);
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  });

  test.each(['', 'localhost', 'localhost.', 'LOCALHOST', '127.0.0.1', '127.0.0.2', '0.0.0.0', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::1%lo'])(
    '%s counts as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  test.each(['127.0.0.1.guard.invalid', 'localhost.guard.invalid', '192.0.2.1', '128.0.0.1', '::2', 'fe80::1%eth0', 'guard-probe.invalid', 'localhost%x.invalid', '127.0.0.1%x.invalid'])(
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

  test('Bun.connect with a unix socket ignores the host beside it', async () => {
    const reply = Promise.withResolvers<string>();
    const options = { unix: socketPath, hostname: HOST, socket: { data: (_socket: unknown, data: Buffer) => reply.resolve(data.toString()) } };
    const socket = await Bun.connect(options as unknown as Parameters<typeof Bun.connect>[0]);
    socket.write('GET / HTTP/1.1\r\n\r\n');
    expect(await reply.promise).toContain('loopback');
    socket.end();
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

  test('node:http uses hostname over host', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get({ hostname: '127.0.0.1', host: HOST, port: server.port, path: '/' }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
    expect(body).toBe('loopback');
  });

  test('node:http with a socketPath ignores the host beside it', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get({ socketPath, host: HOST, path: '/' }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
    expect(body).toBe('loopback');
  });
});

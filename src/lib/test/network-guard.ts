import { afterEach, mock } from 'bun:test';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export class NetworkGuardError extends Error {
  override name = 'NetworkGuardError';
}

type BlockedHost = (args: unknown[]) => string | undefined;

const blockedThisTest: string[] = [];

export function drainBlockedNetworkCalls(): string[] {
  return blockedThisTest.splice(0);
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (bare === '' || bare === 'localhost') return true;
  if (net.isIPv4(bare)) return bare.startsWith('127.') || bare === '0.0.0.0';
  if (!net.isIPv6(bare)) return false;
  const normalized = new URL(`http://[${bare}]`).hostname;
  return normalized === '[::1]' || normalized === '[::]' || /^\[::ffff:7f[0-9a-f]{2}:/.test(normalized);
}

function remote(host: unknown): string | undefined {
  if (typeof host !== 'string' || isLoopbackHost(host)) return undefined;
  return host;
}

function block(api: string, host: string, fix: string): NetworkGuardError {
  const error = new NetworkGuardError(
    `Unit tests cannot use the network: ${api} tried to reach "${host}". ${fix} Only localhost, 127.0.0.0/8, ::1 and unix sockets are allowed.`,
  );
  blockedThisTest.push(error.message);
  return error;
}

function guard(owner: object, key: string, api: string, fix: string, blockedHost: BlockedHost, async: boolean): void {
  const slot = owner as Record<string, unknown>;
  const original = slot[key];
  if (typeof original !== 'function') return;
  slot[key] = new Proxy(original, {
    apply(target, thisArg, args: unknown[]) {
      const host = blockedHost(args);
      if (host === undefined) return Reflect.apply(target, thisArg, args) as unknown;
      const error = block(api, host, fix);
      if (async) return Promise.reject(error);
      throw error;
    },
  });
}

function objectArg(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function parseUrl(raw: string): URL | undefined {
  const base = typeof location === 'undefined' ? undefined : location.href;
  try {
    return new URL(raw, base);
  } catch {
    return undefined;
  }
}

function urlString(input: unknown): string {
  const obj = objectArg(input);
  if (typeof obj?.href === 'string') return obj.href;
  if (typeof obj?.url === 'string') return obj.url;
  return String(input);
}

const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'file:', 'about:']);

function urlHost(input: unknown): string | undefined {
  const url = parseUrl(urlString(input));
  if (url === undefined || LOCAL_SCHEMES.has(url.protocol)) return undefined;
  return remote(url.hostname);
}

const nameHost: BlockedHost = (args) => remote(args[0]);
const anyName: BlockedHost = (args) => String(args[0]);

const fetchHost: BlockedHost = ([input, init]) => (objectArg(init)?.unix ? undefined : urlHost(input));

const socketHost: BlockedHost = ([first, second]) => {
  const options = objectArg(first);
  if (options) return options.path !== undefined || options.socket !== undefined ? undefined : remote(options.host);
  if (typeof first === 'string' && !/^\d+$/.test(first)) return undefined;
  return remote(typeof second === 'string' ? second : objectArg(second)?.host);
};

const requestHost: BlockedHost = (args) => {
  let url: URL | undefined;
  let options: Record<string, unknown> | undefined;
  for (const arg of args.slice(0, 2)) {
    if (typeof arg === 'string') url = parseUrl(arg);
    else if (arg instanceof URL) url = arg;
    else options ??= objectArg(arg);
  }
  if (options?.socketPath !== undefined) return undefined;
  return remote(options?.hostname ?? options?.host ?? url?.hostname);
};

const bunConnectHost: BlockedHost = ([options]) => {
  const opts = objectArg(options);
  return opts?.unix === undefined ? remote(opts?.hostname) : undefined;
};

function guardResolver(owner: object, spec: string, async: boolean): void {
  const fix = `Inject the resolver into the code under test, or mock it with mock.module('${spec}', ...).`;
  guard(owner, 'lookup', `${spec} lookup`, fix, nameHost, async);
  guard(owner, 'lookupService', `${spec} lookupService`, fix, nameHost, async);
  for (const key of Object.getOwnPropertyNames(owner)) {
    if (key.startsWith('resolve') || key === 'reverse') guard(owner, key, `${spec} ${key}`, fix, anyName, async);
  }
}

guardResolver(dns, 'node:dns', false);
guardResolver(dns.Resolver.prototype, 'node:dns', false);
guardResolver(dnsPromises, 'node:dns/promises', true);
guardResolver(dnsPromises.Resolver.prototype, 'node:dns/promises', true);

const bunDnsFix = "Inject the resolver into the code under test, or stub it with spyOn(Bun.dns, 'lookup').";
guard(Bun.dns, 'lookup', 'Bun.dns.lookup', bunDnsFix, nameHost, true);
guard(Bun.dns, 'prefetch', 'Bun.dns.prefetch', bunDnsFix, nameHost, false);
guard(Bun.dns, 'lookupService', 'Bun.dns.lookupService', bunDnsFix, nameHost, true);
for (const key of Object.getOwnPropertyNames(Bun.dns)) {
  if (key.startsWith('resolve') || key === 'reverse') guard(Bun.dns, key, `Bun.dns.${key}`, bunDnsFix, anyName, true);
}

for (const [spec, module] of [['node:http', http], ['node:https', https]] as const) {
  const fix = `Inject the client into the code under test, or mock it with mock.module('${spec}', ...).`;
  guard(module, 'request', `${spec} request`, fix, requestHost, false);
  guard(module, 'get', `${spec} get`, fix, requestHost, false);
}

for (const [spec, module, keys] of [['node:net', net, ['connect', 'createConnection']], ['node:tls', tls, ['connect']]] as const) {
  const fix = `Inject the socket into the code under test, or mock it with mock.module('${spec}', ...).`;
  for (const key of keys) guard(module, key, `${spec} ${key}`, fix, socketHost, false);
}

guard(Bun, 'connect', 'Bun.connect', "Inject the socket into the code under test, or stub it with spyOn(Bun, 'connect').", bunConnectHost, true);

const fetchFix = "Inject fetch into the code under test, or stub it with spyOn(globalThis, 'fetch').";
guard(globalThis, 'fetch', 'fetch', fetchFix, fetchHost, true);

const NativeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = new Proxy(NativeWebSocket, {
  construct(target, args: unknown[], newTarget) {
    const host = urlHost(args[0]);
    if (host !== undefined) {
      throw block('WebSocket', host, 'Inject the WebSocket constructor into the code under test, or replace globalThis.WebSocket in the test.');
    }
    return Reflect.construct(target, args, newTarget) as object;
  },
});

// Patching the module objects above misses named and namespace imports, which bind to the original functions.
for (const [spec, module] of [
  ['node:dns', dns],
  ['node:dns/promises', dnsPromises],
  ['node:http', http],
  ['node:https', https],
  ['node:net', net],
  ['node:tls', tls],
] as const) {
  void mock.module(spec, () => ({ ...module, default: module }));
}

afterEach(() => {
  const messages = drainBlockedNetworkCalls();
  if (messages.length === 0) return;
  throw new NetworkGuardError(`This test made ${messages.length} blocked network call(s), even if the code under test caught the error:\n${messages.join('\n')}`);
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROBE_TIMEOUT_MS, probeAgentHealth, type HealthProbeDeps } from '../health-probe';
import { isFileReadable } from '../lib/tls-enroll';

let dir = '';
let certPath = '';
let keyPath = '';
let otherCertPath = '';
let servers: { kill: () => void; exited: Promise<number> } | undefined;
let ports = { https: 0, http: 0, unhealthy: 0 };

function selfSignedCert(name: string): { cert: string; key: string } {
  const cert = join(dir, `${name}-cert.pem`);
  const key = join(dir, `${name}-key.pem`);
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=hlm-agent-tls',
    '-addext', 'subjectAltName=DNS:localhost',
  ]);
  if (result.status !== 0) throw new Error(`openssl failed: ${result.stderr.toString()}`);
  return { cert, key };
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  void probe.stop(true);
  return port as number;
}

// The root package's Happy-DOM preload replaces fetch and AbortController, and Bun.fetch rejects a Happy-DOM signal.
const nativeFetch = ((input: string, init?: RequestInit) => Bun.fetch(input, { ...init, signal: undefined })) as typeof fetch;

function deps(env: Record<string, string | undefined>): HealthProbeDeps {
  return {
    env,
    isReadable: isFileReadable,
    readFile: (path) => readFileSync(path, 'utf8'),
    fetch: nativeFetch,
    timeoutSignal: () => new AbortController().signal,
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'health-probe-'));
  ({ cert: certPath, key: keyPath } = selfSignedCert('agent'));
  otherCertPath = selfSignedCert('other').cert;
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'lib', 'test', 'health-servers.ts'), certPath, keyPath], {
    env: { PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
  });
  servers = proc;
  const reader = proc.stdout.getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('health servers exited before reporting their ports');
    line += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  ports = JSON.parse(line) as typeof ports;
});

afterAll(async () => {
  servers?.kill();
  await servers?.exited;
  rmSync(dir, { recursive: true, force: true });
});

describe('probeAgentHealth', () => {
  test('passes over HTTPS against the agent self-signed certificate', async () => {
    expect(await probeAgentHealth(deps({ AGENT_PORT: String(ports.https), TLS_CERT_PATH: certPath, TLS_KEY_PATH: keyPath }))).toBe(true);
  });

  test('fails over HTTPS when the served certificate is not the configured one', async () => {
    expect(await probeAgentHealth(deps({ AGENT_PORT: String(ports.https), TLS_CERT_PATH: otherCertPath, TLS_KEY_PATH: keyPath }))).toBe(false);
  });

  test('passes over plain HTTP when no certificate is configured', async () => {
    expect(await probeAgentHealth(deps({ AGENT_PORT: String(ports.http) }))).toBe(true);
  });

  test('probes plain HTTP while TLS is configured but no certificate is enrolled yet', async () => {
    const missing = join(dir, 'missing.pem');
    expect(await probeAgentHealth(deps({ AGENT_PORT: String(ports.http), TLS_CERT_PATH: missing, TLS_KEY_PATH: missing }))).toBe(true);
  });

  test('fails when /health does not answer ok', async () => {
    expect(await probeAgentHealth(deps({ AGENT_PORT: String(ports.unhealthy) }))).toBe(false);
  });

  test('fails when nothing answers on the port', async () => {
    expect(await probeAgentHealth(deps({ AGENT_PORT: String(freePort()) }))).toBe(false);
    expect(await probeAgentHealth(deps({ AGENT_PORT: String(freePort()), TLS_CERT_PATH: certPath, TLS_KEY_PATH: keyPath }))).toBe(false);
  });

  test('fails on its own timeout when the agent accepts the request but never answers', async () => {
    const timeout = new AbortController();
    const requested: number[] = [];
    const hungFetch = ((_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const probe = probeAgentHealth({
      ...deps({ AGENT_PORT: '9090' }),
      fetch: hungFetch,
      timeoutSignal: (ms) => {
        requested.push(ms);
        return timeout.signal;
      },
    });
    timeout.abort();
    expect(await probe).toBe(false);
    expect(requested).toEqual([PROBE_TIMEOUT_MS]);
    expect(PROBE_TIMEOUT_MS).toBeLessThan(5000);
  });

  test('fails when only one of the TLS paths is set, as the agent refuses to start', async () => {
    expect(await probeAgentHealth(deps({ AGENT_PORT: String(ports.http), TLS_CERT_PATH: certPath }))).toBe(false);
  });

  test('is the command the image HEALTHCHECK runs, at the path the image copies it to', () => {
    const dockerfile = readFileSync(join(import.meta.dir, '..', '..', 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^HEALTHCHECK [^\n]*\\\n\s+CMD \["bun", "\/app\/src\/health-probe\.ts"\]$/m);
    expect(dockerfile).toMatch(/^COPY src \.\/src$/m);
    expect(dockerfile).toMatch(/^WORKDIR \/app$/m);
  });

  test('exits 0 as the image HEALTHCHECK command when the agent answers, and 1 when it does not', async () => {
    const run = (port: number) =>
      Bun.spawn([process.execPath, join(import.meta.dir, '..', 'health-probe.ts')], {
        env: { PATH: process.env.PATH ?? '', AGENT_PORT: String(port), TLS_CERT_PATH: certPath, TLS_KEY_PATH: keyPath },
      }).exited;
    expect(await run(ports.https)).toBe(0);
    expect(await run(freePort())).toBe(1);
  });
});

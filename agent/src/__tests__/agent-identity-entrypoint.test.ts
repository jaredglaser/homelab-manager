import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { waitForCondition } from '../lib/test/wait-for-condition';
import { AGENT_IDENTITY_HEADER } from '../types';

const HOST = 'identity-host';
const VERSION = '7.7.7-test';

let proc: ReturnType<typeof Bun.spawn>;
let baseUrl = '';
let token = '';
let output = '';

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  void probe.stop(true);
  return port as number;
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  token = await new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('homelab-manager')
    .setAudience(HOST)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime('120s')
    .sign(privateKey);
  const port = freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  proc = Bun.spawn([process.execPath, `${import.meta.dir}/../index.ts`], {
    env: {
      PATH: process.env.PATH ?? '',
      AGENT_PORT: String(port),
      AGENT_HOST_NAME: HOST,
      AGENT_TRUSTED_PUBKEY: JSON.stringify(await exportJWK(publicKey)),
      DOCKER_HOST: 'tcp://127.0.0.1:1',
      AGENT_VERSION: VERSION,
    },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) output += decoder.decode(chunk);
  })();
  await waitForCondition(() => output.includes('Agent listening'), { timeoutMs: 4000, message: 'agent did not start' });
});

afterAll(() => {
  proc.kill();
});

const authed = () => ({ headers: { Authorization: `Bearer ${token}` } });

describe('the real agent entrypoint', () => {
  it('stamps the health, auth failure and not-found responses', async () => {
    const health = await Bun.fetch(`${baseUrl}/health`);
    const unauthorized = await Bun.fetch(`${baseUrl}/info`);
    const missing = await Bun.fetch(`${baseUrl}/no-such-route`, authed());
    expect([health.status, unauthorized.status, missing.status]).toEqual([503, 401, 404]);
    for (const response of [health, unauthorized, missing]) {
      expect(response.headers.get(AGENT_IDENTITY_HEADER)).toBe('1');
      expect([...response.headers.values()].join('\n')).not.toContain(VERSION);
    }
  });

  it('stamps an SSE stream before its first frame', async () => {
    const response = await Bun.fetch(`${baseUrl}/containers/events`, authed());
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get(AGENT_IDENTITY_HEADER)).toBe('1');
    await response.body?.cancel();
  });
});

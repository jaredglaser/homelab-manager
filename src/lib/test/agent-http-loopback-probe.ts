/**
 * Standalone probe run as a subprocess: bun test's happy-dom preload replaces
 * the global fetch/Response constructors, and that fetch ignores the native
 * `tls` option, so the loopback assertions need a realm with native globals
 * (the production runtime environment the wrapper actually serves).
 */
import { join } from 'node:path';
import { agentFetch } from '../clients/agent-http';

const fixtureDir = join(import.meta.dir, '../clients/__tests__/fixtures');
const fixtureCert = await Bun.file(join(fixtureDir, 'agent-tls-fixture-cert.pem')).text();
const fixtureKeyPath = join(fixtureDir, 'agent-tls-fixture-key.pem');

const tlsServer = Bun.serve({
  port: 0,
  tls: { cert: Bun.file(join(fixtureDir, 'agent-tls-fixture-cert.pem')), key: Bun.file(fixtureKeyPath) },
  fetch: () => new Response(JSON.stringify({ ok: true })),
});
const plainServer = Bun.serve({
  port: 0,
  fetch: () => new Response(JSON.stringify({ ok: true })),
});

async function expectRejected(url: string, tls: { caCertPem?: string | null }): Promise<void> {
  try {
    await agentFetch(url, {}, tls);
  } catch {
    return;
  }
  throw new Error(`Expected fetch to ${url} to be rejected`);
}

try {
  const ok = await agentFetch(`https://localhost:${tlsServer.port}/`, {}, { caCertPem: fixtureCert });
  if (ok.status !== 200) throw new Error(`pinned ca request returned ${ok.status}`);
  if (JSON.stringify(await ok.json()) !== '{"ok":true}') throw new Error('pinned ca request body mismatch');

  await expectRejected(`https://localhost:${tlsServer.port}/`, { caCertPem: 'not a certificate' });
  await expectRejected(`https://127.0.0.2:${tlsServer.port}/`, { caCertPem: fixtureCert });
  await expectRejected(`https://localhost:${tlsServer.port}/`, {});

  const plain = await agentFetch(`http://localhost:${plainServer.port}/`, {}, { caCertPem: fixtureCert });
  if (plain.status !== 200) throw new Error(`http pass-through returned ${plain.status}`);

  console.log('loopback probe ok');
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  tlsServer.stop(true);
  plainServer.stop(true);
}

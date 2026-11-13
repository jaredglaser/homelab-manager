/**
 * Standalone probe run as a subprocess: bun test's happy-dom preload replaces
 * the global fetch/Response constructors, and that fetch ignores the native
 * `tls` option, so the loopback assertions need a realm with native globals
 * (the production runtime environment the wrapper actually serves).
 */
import { join } from 'node:path';
import { agentFetch, openAgentWebSocket } from '../clients/agent-http';

const fixtureDir = join(import.meta.dir, '../clients/__tests__/fixtures');
const fixtureCert = await Bun.file(join(fixtureDir, 'agent-tls-fixture-cert.pem')).text();
const fixtureKeyPath = join(fixtureDir, 'agent-tls-fixture-key.pem');

const tlsServer = Bun.serve({
  port: 0,
  tls: { cert: Bun.file(join(fixtureDir, 'agent-tls-fixture-cert.pem')), key: Bun.file(fixtureKeyPath) },
  fetch(req, server) {
    // WebSocket upgrades must be taken here. The default response handler never upgrades.
    if (server.upgrade(req)) return undefined;
    return new Response(JSON.stringify({ ok: true }));
  },
  websocket: {
    open(ws) {
      ws.send('agent-hello');
    },
    message(ws) {
      // Required by Bun's WebSocketHandler type. The probe never sends client frames.
      ws.close(1000);
    },
  },
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

/** Resolves on the agent's hello frame, and rejects on error, wrong frame, or timeout. */
function expectWebSocketHello(url: string, tls: { caCertPem?: string | null }): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`expected hello frame from ${url}, timed out`)), 5000);
    const fail = (why: string) => {
      clearTimeout(timer);
      reject(new Error(why));
    };
    let ws: WebSocket;
    try {
      ws = openAgentWebSocket(url, {}, tls);
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    ws.onmessage = (event) => {
      if (event.data === 'agent-hello') {
        clearTimeout(timer);
        ws.close(1000);
        resolve();
      } else {
        fail(`unexpected first frame from ${url}: ${String(event.data)}`);
      }
    };
    ws.onerror = (ev) => fail(`websocket to ${url} errored: ${String((ev as ErrorEvent).error ?? 'unknown')}`);
    ws.onclose = (ev) => {
      if (ev.code !== 1000) fail(`websocket to ${url} closed before hello (code ${ev.code})`);
    };
  });
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

  // wss: the client WebSocket must honor tls.ca the same way fetch does.
  await expectWebSocketHello(`wss://localhost:${tlsServer.port}/ws`, { caCertPem: fixtureCert });
  await expectWebSocketHello(`wss://localhost:${tlsServer.port}/ws`, { caCertPem: 'not a certificate' }).then(
    () => {
      throw new Error('expected a wrong-ca websocket handshake to fail');
    },
    (err: unknown) => {
      if (err instanceof Error && err.message.includes('timed out')) throw err;
      // Any other rejection (handshake error) is the expected failure shape.
    },
  );
  try {
    openAgentWebSocket(`wss://localhost:${tlsServer.port}/ws`, {}, {});
    throw new Error('expected openAgentWebSocket to refuse a wss URL without a pinned cert');
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('No pinned TLS certificate')) throw err;
  }

  console.log('loopback probe ok');
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  tlsServer.stop(true);
  plainServer.stop(true);
}

/**
 * Minimal TLS terminator for the auth e2e lane's https target. Fronts a plain
 * http Nitro instance so the app is reachable over https://localhost:<port>,
 * which is what makes the browser accept the __Host-/Secure session cookie.
 * Streams requests and responses through unchanged (method, headers, body).
 *
 * Usage: bun scripts/e2e-tls-proxy.ts <listenPort> <targetHttpPort>
 * Reads the cert from e2e-build/auth/certs (see e2e-gen-cert.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const listenPort = Number(process.argv[2]);
const targetPort = Number(process.argv[3]);

if (!listenPort || !targetPort) {
  console.error('Usage: bun scripts/e2e-tls-proxy.ts <listenPort> <targetHttpPort>');
  process.exit(1);
}

const certDir = path.resolve('e2e-build/auth/certs');
const cert = readFileSync(path.join(certDir, 'cert.pem'));
const key = readFileSync(path.join(certDir, 'key.pem'));

Bun.serve({
  port: listenPort,
  tls: { cert, key },
  async fetch(req) {
    const url = new URL(req.url);
    const target = `http://localhost:${targetPort}${url.pathname}${url.search}`;
    // Redirect must not auto-follow: the app's 302s (login/callback) are the
    // behavior under test, so the browser has to see them, not the proxy.
    return fetch(target, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'manual',
      // @ts-expect-error Bun supports duplex streaming bodies
      duplex: 'half',
    });
  },
});

console.info(`[e2e-tls-proxy] https://localhost:${listenPort} -> http://localhost:${targetPort}`);

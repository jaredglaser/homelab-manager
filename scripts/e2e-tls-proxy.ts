/** TLS terminator in front of a plain http Nitro, so the browser treats the app as a secure context. Usage: bun scripts/e2e-tls-proxy.ts <listenPort> <targetHttpPort> */
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
    // The browser must see the app's 302s, so the proxy cannot follow them.
    return await fetch(target, {
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

// Runs as its own process: under the root package's Happy-DOM preload, Bun.serve rejects the Response a test builds.
const [certPath, keyPath] = process.argv.slice(2);

const health = (request: Request) =>
  new URL(request.url).pathname === '/health' ? Response.json({ status: 'ok' }) : new Response(null, { status: 404 });

const https = Bun.serve({
  port: 0,
  hostname: 'localhost',
  tls: { cert: Bun.file(certPath), key: Bun.file(keyPath) },
  fetch: health,
});
const http = Bun.serve({ port: 0, hostname: 'localhost', fetch: health });
const unhealthy = Bun.serve({ port: 0, hostname: 'localhost', fetch: () => new Response(null, { status: 503 }) });

console.info(JSON.stringify({ https: https.port, http: http.port, unhealthy: unhealthy.port }));

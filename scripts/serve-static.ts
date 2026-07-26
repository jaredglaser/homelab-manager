/**
 * Serves the prebuilt demo / e2e bundles for Playwright. Unlike `vite dev`, a
 * production build has no dev SSR pass or dependency re-optimization, so MSW
 * reliably intercepts every request (including route loaders) before the app
 * renders.
 */
import path from 'node:path';

const dir = process.argv[2];
const port = Number(process.argv[3]);

if (!dir || !port) {
  console.error('Usage: bun scripts/serve-static.ts <dir> <port>');
  process.exit(1);
}

// The TanStack Start SPA build emits the shell as `_shell.html`; serve it as the
// fallback document for client-routed paths.
const baseDir = path.resolve(dir);
const shellPath = path.join(baseDir, '_shell.html');

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    // Resolve under baseDir and reject anything that escapes it (`..` traversal).
    const resolved = path.resolve(baseDir, `.${decodeURIComponent(url.pathname)}`);
    if (resolved !== baseDir && !resolved.startsWith(`${baseDir}${path.sep}`)) {
      return new Response('Forbidden', { status: 403 });
    }
    const file = Bun.file(resolved);
    if (await file.exists()) {
      return new Response(file);
    }
    if (/\.[a-zA-Z0-9]+$/.test(url.pathname)) {
      return new Response('Not found', { status: 404 });
    }
    return new Response(Bun.file(shellPath), {
      headers: { 'Content-Type': 'text/html' },
    });
  },
});

console.info(`[serve-static] serving ${dir} on http://localhost:${port}`);

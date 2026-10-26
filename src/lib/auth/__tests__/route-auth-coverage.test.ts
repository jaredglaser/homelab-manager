import { describe, it, expect } from 'bun:test';

const REPO_ROOT = new URL('../../../..', import.meta.url).pathname;

// A route file must reference one of the real auth enforcement seams or be on
// the explicit allowlist below; anything else fails this test.
const AUTH_SEAM = /authMiddleware|requireRole|authenticateWsUpgrade|resolveUserFromCookie/;

// Unauthenticated BY DESIGN: the health probe and the auth/session lifecycle
// routes that establish or clear the session itself.
const ROUTE_ALLOWLIST = new Set([
  'src/routes/api/health.ts',
  'src/routes/api/auth/login.ts',
  'src/routes/api/auth/callback.ts',
  'src/routes/api/auth/logout.ts',
]);

// Server functions that read or bootstrap the session and therefore cannot
// require one: file path and export name.
const SERVER_FN_ALLOWLIST = new Set(['src/data/auth.functions.tsx:getSession']);

const SERVER_FN_EXPORT = /export const ([A-Za-z0-9_$]+) = createServerFn/g;

// Read through Bun's file APIs: node:fs is mocked by sibling suites and the
// mock leaks across files.
async function scanFiles(patterns: string[]): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    for await (const relative of glob.scan({ cwd: REPO_ROOT, onlyFiles: true })) {
      if (relative.includes('__tests__/')) continue;
      sources.set(relative, await Bun.file(REPO_ROOT + relative).text());
    }
  }
  return sources;
}

describe('server endpoint auth coverage', () => {
  it('authenticates every route file except the explicit unauthenticated allowlist', async () => {
    const routes = await scanFiles(['src/routes/api/**/*.ts', 'server/routes/**/*.ts']);
    expect(routes.size).toBeGreaterThan(5);

    const unauthenticated: string[] = [];
    for (const [path, source] of routes) {
      if (ROUTE_ALLOWLIST.has(path)) continue;
      if (!AUTH_SEAM.test(source)) unauthenticated.push(path);
    }
    expect(unauthenticated).toEqual([]);
  });

  it('attaches authMiddleware to every server function except session bootstrap', async () => {
    const files = await scanFiles(['src/data/**/*.functions.tsx', 'src/data/**/functions.tsx']);
    expect(files.size).toBeGreaterThan(5);

    const unauthenticated: string[] = [];
    for (const [path, source] of files) {
      for (const match of source.matchAll(SERVER_FN_EXPORT)) {
        const name = match[1];
        const chainEnd = source.indexOf('.handler(', match.index + match[0].length);
        const chain = source.slice(match.index, chainEnd === -1 ? undefined : chainEnd);
        if (!chain.includes('authMiddleware') && !SERVER_FN_ALLOWLIST.has(`${path}:${name}`)) {
          unauthenticated.push(`${path}:${name}`);
        }
      }
    }
    expect(unauthenticated).toEqual([]);
  });
});

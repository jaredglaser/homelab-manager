import { defineConfig, devices } from '@playwright/test';

/**
 * Two targets, both static production builds (no dev server) served over MSW so
 * route loaders, auth, and SSE are all intercepted before first render. They
 * share the handlers in `src/lib/mock`; `bun run e2e:build` builds and stages
 * each under `e2e-build/` before the run.
 *
 * - `demo`: the public demo build (`VITE_DEMO_MODE=true`). MSW is always on and
 *   the UI shows its demo-only affordances (banner, disabled terminal). Smoke
 *   coverage only, so the deployed demo never silently breaks.
 * - `app`: the real, non-demo UI with MSW enabled via `VITE_ENABLE_MSW=true`.
 *   This is the deep-test target: it exercises production code paths and lets
 *   tests layer per-scenario response overrides on top of the mocks via the
 *   `overrideServerFn` fixture (a window-seeded map the MSW handler reads;
 *   `page.route` can't reach `/_serverFn`, the service worker answers first).
 *
 * Specs ending in `.demo.e2e.ts` run against `demo`; all other `*.e2e.ts` run
 * against `app`. The `.e2e.ts` suffix keeps `bun test` from collecting them:
 * bun's runner claims `*.spec.ts` and Playwright's `test()` throws under it.
 */

const DEMO_PORT = 3100;
const APP_PORT = 3101;
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'app',
      testMatch: /.*\.e2e\.ts$/,
      testIgnore: /.*\.demo\.e2e\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${APP_PORT}` },
    },
    {
      name: 'demo',
      testMatch: /.*\.demo\.e2e\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${DEMO_PORT}` },
    },
  ],
  webServer: [
    {
      command: `bun run e2e:server:app`,
      port: APP_PORT,
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: `bun run e2e:server:demo`,
      port: DEMO_PORT,
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  ],
});

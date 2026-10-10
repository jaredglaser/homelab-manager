import { defineConfig, devices } from '@playwright/test';

/**
 * Auth lane: a SEPARATE config from playwright.config.ts because this lane runs
 * the real Nitro server against a real Pocket ID + Postgres, not the static MSW
 * builds. Keeping it separate means the MSW lane never tries to start these
 * servers (and vice versa).
 *
 * The seed + build run BEFORE `playwright test` (see the `test:e2e:auth` script),
 * so e2e-build/auth/oidc.env exists when these webServers start. Pocket ID and
 * Postgres must already be reachable (CI service containers, or local Docker).
 *
 * - `auth-http`  (3201): OIDC_REDIRECT_URI=http  -> asserts the plain `session` cookie.
 * - `auth-https` (3202): OIDC_REDIRECT_URI=https -> asserts `__Host-session` + Secure
 *   and the single-name read. https://localhost is a secure context in Chromium,
 *   so the prefixed/Secure cookie is accepted; `ignoreHTTPSErrors` allows the
 *   self-signed cert.
 */
const isCI = !!process.env.CI;
const HTTP_PORT = 3201;
const HTTPS_PORT = 3202;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // one Pocket ID user / one-time token; keep the flow serial
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { trace: 'on-first-retry' },
  projects: [
    {
      name: 'auth-http',
      testMatch: /.*\.authhttp\.e2e\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${HTTP_PORT}` },
    },
    {
      name: 'auth-https',
      testMatch: /.*\.authhttps\.e2e\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `https://localhost:${HTTPS_PORT}`,
        ignoreHTTPSErrors: true,
      },
    },
  ],
  webServer: [
    {
      command: 'bun scripts/e2e-auth-server.ts http',
      port: HTTP_PORT,
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: 'bun scripts/e2e-auth-server.ts https',
      url: `https://localhost:${HTTPS_PORT}/`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  ],
});

import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
// The callback URLs in scripts/e2e-auth-seed.ts and the BASE constants in the specs hardcode these ports.
const HTTP_PORT = 3201;
const HTTPS_PORT = 3202;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
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

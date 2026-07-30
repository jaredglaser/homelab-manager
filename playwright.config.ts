import { defineConfig, devices } from '@playwright/test';

/**
 * Both targets are static production builds (no dev server) served over MSW, so
 * route loaders, auth, and SSE are intercepted before first render.
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
      testIgnore: /.*\.(demo|mobile)\.e2e\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${APP_PORT}` },
    },
    {
      name: 'mobile',
      testMatch: /.*\.mobile\.e2e\.ts$/,
      use: { ...devices['Pixel 7'], baseURL: `http://localhost:${APP_PORT}` },
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

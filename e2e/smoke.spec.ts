import { test, expect } from './fixtures';

/**
 * Basic harness check for the `app` target: the real (non-demo) UI boots against
 * the MSW backend, the root redirects to /docker, the mocked session avoids a
 * login redirect, and the Docker dashboard renders containers from the mocked
 * inventory stream.
 */
test('docker dashboard renders mocked containers', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/docker$/);

  // A container name from the mock inventory (src/lib/mock/entities.ts).
  await expect(page.getByText('plex', { exact: false }).first()).toBeVisible();

  // Real UI: the demo-only banner must not be present on the app target.
  await expect(page.getByText('Demo mode')).toHaveCount(0);
});

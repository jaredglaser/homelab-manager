import { test, expect } from './fixtures';

/**
 * Basic harness check for the `demo` target: the public demo build boots, shows
 * its demo banner, and renders mocked Docker data, so the deployed demo site does
 * not silently break.
 */
test('public demo boots with banner and mocked data', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/docker$/);
  await expect(page.getByText('Demo mode')).toBeVisible();
  await expect(page.getByText('plex', { exact: false }).first()).toBeVisible();
});

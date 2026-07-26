import { test, expect } from './fixtures';

test('docker dashboard renders mocked containers', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/docker$/);

  // A container name from the mock inventory (src/lib/mock/entities.ts).
  await expect(page.getByText('plex', { exact: false }).first()).toBeVisible();

  await expect(page.getByText('Demo mode')).toHaveCount(0);
});

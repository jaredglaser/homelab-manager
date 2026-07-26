import { test, expect } from './fixtures';

test('public demo boots with banner and mocked data', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/docker$/);
  await expect(page.getByText('Demo mode')).toBeVisible();
  await expect(page.getByText('plex', { exact: false }).first()).toBeVisible();
});

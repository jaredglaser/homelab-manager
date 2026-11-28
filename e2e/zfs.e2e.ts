import { test, expect, expectLiveTextUpdate } from './fixtures';

test('renders the ZFS pool hierarchy', async ({ page }) => {
  await page.goto('/zfs');

  await expect(page.getByText(/pools/).first()).toBeVisible();
  await expect(page.getByText(/disks/).first()).toBeVisible();

  // Pool, then a vdev nested under it (tree data via getSubRows).
  await expect(page.getByText('nas01').first()).toBeVisible();
  await expect(page.getByText('mirror-0').first()).toBeVisible();
});

test('shows the device groups of a pool inside it, under their labels', async ({ page }) => {
  await page.goto('/zfs');

  await page.locator('[role="button"]').filter({ hasText: /^rust/ }).first().click();

  for (const label of ['Special devices', 'Dedup devices', 'Log devices', 'Cache devices', 'Spares']) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
});

test('streams live ZFS stats that change over time', async ({ page }) => {
  await page.goto('/zfs');
  await expect(page.getByText('nas01').first()).toBeVisible();

  await expectLiveTextUpdate(
    page.locator('[role="button"]').filter({ hasText: 'nas01' }),
  );
});

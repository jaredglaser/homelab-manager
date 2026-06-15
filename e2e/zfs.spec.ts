import { test, expect } from './fixtures';

test('renders the ZFS pool hierarchy', async ({ page }) => {
  await page.goto('/zfs');

  await expect(page.getByText(/pools/).first()).toBeVisible();
  await expect(page.getByText(/disks/).first()).toBeVisible();

  // Pool, then a vdev nested under it (tree data via getSubRows).
  await expect(page.getByText('nas01').first()).toBeVisible();
  await expect(page.getByText('mirror-0').first()).toBeVisible();
});

test('streams live ZFS stats that change over time', async ({ page }) => {
  await page.goto('/zfs');
  await expect(page.getByText('nas01').first()).toBeVisible();

  const body = page.locator('body');
  const first = await body.innerText();
  await expect
    .poll(async () => (await body.innerText()) !== first, { timeout: 8000 })
    .toBe(true);
});

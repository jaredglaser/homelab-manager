import { test, expect } from './fixtures';

/**
 * Every top-level route renders its own live-data view (not an error boundary)
 * against the MSW backend. This catches route loaders, SSE wiring, and per-page
 * server functions breaking together in a way unit tests cannot, since each runs
 * the real router transition and data fetch.
 */
const routes = [
  { path: '/docker', signature: /hosts/i },
  { path: '/stacks', signature: /Stacks Overview/i },
  { path: '/zfs', signature: /pools/i },
  { path: '/proxmox', signature: /nodes/i },
  { path: '/settings', signature: /Settings/i },
];

for (const { path, signature } of routes) {
  test(`${path} loads its data view`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByText(signature).first()).toBeVisible();
    // The root error boundary must not have caught a loader/render failure.
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });
}

test('top navigation moves between sections', async ({ page }) => {
  await page.goto('/docker');
  await page.getByRole('tab', { name: 'Stacks' }).click();
  await expect(page).toHaveURL(/\/stacks$/);
  await expect(page.getByText('Stacks Overview')).toBeVisible();

  await page.getByRole('tab', { name: 'ZFS' }).click();
  await expect(page).toHaveURL(/\/zfs$/);
});

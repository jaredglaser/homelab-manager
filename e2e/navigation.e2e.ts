import { test, expect } from './fixtures';

const routes = [
  { path: '/docker', signature: /hosts/i },
  { path: '/stacks', signature: /Stacks Overview/i },
  { path: '/zfs', signature: /pools/i },
  { path: '/proxmox', signature: /nodes/i },
  { path: '/settings', signature: /Data Retention/i },
];

for (const { path, signature } of routes) {
  test(`${path} loads its data view`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByText(signature).first()).toBeVisible();
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

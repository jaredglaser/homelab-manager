import { test, expect } from './fixtures';

test('the tab bar is replaced by a drawer trigger', async ({ page }) => {
  await page.goto('/docker');

  await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Stacks' })).toHaveCount(0);
});

test('the drawer navigates between sections', async ({ page }) => {
  await page.goto('/docker');

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('link', { name: 'Stacks' }).click();

  await expect(page).toHaveURL(/\/stacks$/);
  await expect(page.getByText('Stacks Overview')).toBeVisible();
  await expect(page.getByRole('link', { name: 'ZFS' })).toHaveCount(0);
});

test('the drawer exposes submenus that desktop opens on hover', async ({ page }) => {
  await page.goto('/stacks');

  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: /expand settings menu/i }).click();

  await expect(page.getByRole('menuitem', { name: 'Managed Hosts' })).toBeVisible();
});

// Route bodies are widened by their tables and are covered by the per-route
// mobile specs; this only pins the shell chrome, which every route inherits.
test('the header fits the viewport on every route', async ({ page }) => {
  for (const path of ['/docker', '/stacks', '/zfs', '/proxmox', '/settings']) {
    await page.goto(path);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);

    const header = page.locator('header').first();
    const box = await header.boundingBox();
    const viewport = page.viewportSize();
    expect(box, `${path} has no header`).not.toBeNull();
    expect(box!.width, `${path} header overflows`).toBeLessThanOrEqual(viewport!.width);
  }
});

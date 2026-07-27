import { test, expect } from './fixtures';

test('the ZFS pool table does not scroll the document horizontally', async ({ page }) => {
  await page.goto('/zfs');
  await expect(page.getByText('nas01').first()).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, '/zfs overflows the viewport horizontally').toBeLessThanOrEqual(1);
});

test('the ZFS pool table itself does not scroll sideways', async ({ page }) => {
  await page.goto('/zfs');
  await expect(page.getByText('nas01').first()).toBeVisible();

  const header = page.locator('[data-slot="datatable-header"]').first();
  const headerOverflow = await header.evaluate((el) => {
    const scroller = el.closest('.overflow-x-auto');
    if (!scroller) return 0;
    return scroller.scrollWidth - scroller.clientWidth;
  });
  expect(headerOverflow).toBeLessThanOrEqual(1);
});

test('tapping the single-disk badge reveals the disk name that only exists in its tooltip', async ({ page }) => {
  await page.goto('/zfs');
  await expect(page.getByText('nas01').first()).toBeVisible();

  const badge = page.getByText('single disk').first();
  await expect(badge).toBeVisible();
  expect(await badge.boundingBox()).not.toBeNull();

  await badge.tap();
  await expect(page.getByRole('tooltip')).toBeVisible();
});

test('the Proxmox host/guest tables do not scroll the document horizontally', async ({ page }) => {
  await page.goto('/proxmox');
  await expect(page.getByText('pve1').first()).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, '/proxmox overflows the viewport horizontally').toBeLessThanOrEqual(1);
});

test('a Proxmox node accordion row wraps its metrics instead of forcing horizontal scroll', async ({ page }) => {
  await page.goto('/proxmox');
  const row = page.getByRole('button', { name: /pve1/ }).first();
  await expect(row).toBeVisible();

  const rowOverflow = await row.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(rowOverflow).toBeLessThanOrEqual(1);
});

test('tapping the interval toggle reveals its tooltip instead of staying hidden behind hover', async ({ page }) => {
  await page.goto('/proxmox');
  await expect(page.getByText('pve1').first()).toBeVisible();

  const relaxedButton = page.getByRole('button', { name: '10 seconds (relaxed)' });
  await expect(relaxedButton).toBeVisible();

  const box = await relaxedButton.boundingBox();
  expect(box!.height, 'interval toggle is under the 44px touch target').toBeGreaterThanOrEqual(44);

  await relaxedButton.tap();
  await expect(page.getByText('Relaxed updates (10 seconds)')).toBeVisible();
});

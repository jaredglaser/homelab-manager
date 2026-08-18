import { test, expect } from './fixtures';

test('the container table fits the viewport', async ({ page }) => {
  await page.goto('/docker');
  await expect(page.getByText('nginx-proxy').first()).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, '/docker overflows the viewport horizontally').toBeLessThanOrEqual(1);
});

test('the table itself does not scroll sideways', async ({ page }) => {
  await page.goto('/docker');
  await expect(page.getByText('nginx-proxy').first()).toBeVisible();

  const rowOverflow = await page.evaluate(() => {
    const row = document.querySelector('[data-host-id="192.168.1.10"]');
    if (!row) return null;
    const scroller = row.closest('.overflow-x-auto');
    if (!scroller) return 0;
    return scroller.scrollWidth - scroller.clientWidth;
  });

  expect(rowOverflow, 'container table scrolls horizontally').not.toBeNull();
  expect(rowOverflow!).toBeLessThanOrEqual(1);
});

test('the metric group toggle swaps which columns are shown', async ({ page }) => {
  await page.goto('/docker');
  await expect(page.getByText('nginx-proxy').first()).toBeVisible();

  const header = page.locator('[data-slot="datatable-header"]').first();
  await expect(header.getByText('CPU')).toBeVisible();
  await expect(header.getByText('Net RX')).toHaveCount(0);

  const toggle = page.getByRole('button', { name: 'Network' }).first();
  await expect(toggle).toBeVisible();

  const box = await toggle.boundingBox();
  expect(box!.height, 'metric toggle is under the 44px touch target').toBeGreaterThanOrEqual(44);

  await toggle.click();

  await expect(header.getByText('Net RX')).toBeVisible();
  await expect(header.getByText('CPU')).toHaveCount(0);
});

test('a container opens its detail view from a tap', async ({ page }) => {
  await page.goto('/docker');
  await page.getByText('nginx-proxy').first().click();

  await expect(page.getByRole('button', { name: 'Stop container' }).first()).toBeVisible();
});

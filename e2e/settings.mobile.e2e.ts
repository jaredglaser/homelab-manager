import { test, expect, overrideServerFn } from './fixtures';

test('the settings page does not scroll the document horizontally', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByText('Something went wrong')).toHaveCount(0);

  const scrollWidths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidths.scrollWidth).toBeLessThanOrEqual(scrollWidths.clientWidth);
});

test('a slider thumb meets the 44px touch target', async ({ page }) => {
  await page.goto('/settings');

  const thumb = page.locator('[data-slot="slider-thumb"]').first();
  await expect(thumb).toBeVisible();

  // `.tap-target` expands the hit area via a pseudo-element rather than the
  // painted thumb itself, so the touch target lives in ::after, not the
  // element's own bounding box.
  const hitArea = await thumb.evaluate((el) => {
    const after = getComputedStyle(el, '::after');
    return { width: parseFloat(after.width), height: parseFloat(after.height) };
  });
  expect(hitArea.width).toBeGreaterThanOrEqual(44);
  expect(hitArea.height).toBeGreaterThanOrEqual(44);
});

test('an admin sees the auth management tables rendered as cards, not a wide table', async ({ page }) => {
  await overrideServerFn(page, 'getSession', {
    id: 7,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
  });
  await overrideServerFn(page, 'listUsers', [
    {
      id: 1,
      oidcSubject: 'sub1',
      email: 'alice@example.com',
      name: 'Alice',
      role: 'admin',
      oidcGroups: ['homelab-admins'],
      lastLogin: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]);

  await page.goto('/settings');
  await expect(page.getByText('alice@example.com')).toBeVisible();
  await expect(page.locator('table', { hasText: 'alice@example.com' })).toHaveCount(0);
});

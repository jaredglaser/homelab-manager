import { test, expect } from './fixtures';

test('toggles color mode and persists it across reload', async ({ page }) => {
  await page.goto('/docker');

  const html = page.locator('html');
  const initial = await html.getAttribute('data-color-scheme');
  expect(initial).toBe('dark');

  await page.getByRole('button', { name: /toggle dark mode/i }).click();
  await expect(html).toHaveAttribute('data-color-scheme', 'light');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'light');
});

import { test, expect } from './fixtures';

/**
 * Color mode is applied to the document before first paint (inline script in
 * __root) and toggled at runtime, then persisted. The attribute flip and its
 * persistence across a reload are real-DOM concerns unit tests cannot assert.
 */
test('toggles color mode and persists it across reload', async ({ page }) => {
  await page.goto('/docker');

  const html = page.locator('html');
  const initial = await html.getAttribute('data-color-scheme');
  expect(initial).toBe('dark');

  await page.getByRole('button', { name: /toggle dark mode/i }).click();
  await expect(html).toHaveAttribute('data-color-scheme', 'light');

  await page.reload();
  // The pre-paint script must restore the persisted scheme, not flash to dark.
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'light');
});

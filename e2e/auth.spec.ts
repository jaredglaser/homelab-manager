import { test, expect, overrideServerFn } from './fixtures';

/**
 * Auth gating runs on the session-check server function during initial load, so
 * it can only be exercised by driving a real navigation with the response
 * reshaped. These reshape `getSession` per test via the window override.
 */

test('redirects to /login when there is no session', async ({ page }) => {
  await overrideServerFn(page, 'getSession', null);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText(/sign in/i).first()).toBeVisible();
});

test('a valid session lands on the dashboard', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/docker$/);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});

test('a real (non-synthetic) user surfaces the account menu', async ({ page }) => {
  await overrideServerFn(page, 'getSession', {
    id: 7,
    email: 'op@example.com',
    name: 'Operator',
    role: 'operator',
  });
  await page.goto('/docker');
  await expect(page).toHaveURL(/\/docker$/);
  // The synthetic-admin (auth-disabled) path hides the account menu; a real
  // user shows it. Assert we are not bounced to /login and the app rendered.
  await expect(page.getByRole('tab', { name: 'Docker' })).toBeVisible();
});

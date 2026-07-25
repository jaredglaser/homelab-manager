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

  // A real user surfaces the account menu; opening it exposes the logout link.
  const accountMenu = page.getByRole('button', { name: 'Account menu' });
  await expect(accountMenu).toBeVisible();
  await accountMenu.click();
  await expect(page.getByRole('menuitem', { name: /log out/i })).toBeVisible();
});

test('the auth-disabled (synthetic admin) session hides the account menu', async ({ page }) => {
  // The default mock session is the synthetic admin (AUTH_DISABLED path), which
  // useAuth treats as "no real user", so the account menu must not render.
  await page.goto('/docker');
  await expect(page).toHaveURL(/\/docker$/);
  await expect(page.getByRole('button', { name: 'Account menu' })).toHaveCount(0);
});

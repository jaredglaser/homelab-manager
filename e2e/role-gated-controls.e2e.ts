import type { Page } from '@playwright/test';
import { functionIdFromUrl, resolveFunctionName } from '@/lib/mock/handlers/function-id';
import { test, expect, overrideServerFn } from './fixtures';

const VIEWER_COPY = 'Your role can view but not change things. Ask an operator or admin.';

// Absence has no event to wait on, so the window is bounded. The admin case proves a click is seen inside it.
function nextHealthCheck(page: Page): Promise<boolean> {
  const isHealthCheck = (url: string) => {
    const segment = functionIdFromUrl(url);
    return segment !== null && resolveFunctionName(segment) === 'checkHostHealth';
  };
  return page
    .waitForRequest((request) => isHealthCheck(request.url()), { timeout: 1500 })
    .then(() => true, () => false);
}

async function openSettingsAs(page: Page, role: 'viewer' | 'admin') {
  await overrideServerFn(page, 'getSession', { id: 7, email: `${role}@example.com`, name: role, role });
  await page.goto('/settings');
  const check = page.getByRole('button', { name: 'check health' }).first();
  await expect(check).toBeVisible();
  return check;
}

test('a viewer sees Check health disabled, with the reason on hover and on keyboard focus, and a click sends nothing', async ({ page }) => {
  const check = await openSettingsAs(page, 'viewer');
  await expect(check).toHaveAttribute('aria-disabled', 'true');

  await check.hover();
  await expect(page.getByText(VIEWER_COPY)).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByText(VIEWER_COPY)).toBeHidden();

  await page.getByRole('button', { name: 'edit host' }).first().focus();
  await page.keyboard.press('Shift+Tab');
  await expect(check).toBeFocused();
  await expect(page.getByText(VIEWER_COPY)).toBeVisible();

  const sent = nextHealthCheck(page);
  await check.click({ force: true });
  expect(await sent).toBe(false);
});

test('an admin can run Check health, which sends its request', async ({ page }) => {
  const check = await openSettingsAs(page, 'admin');
  await expect(check).not.toHaveAttribute('aria-disabled', 'true');

  const sent = nextHealthCheck(page);
  await check.click();
  expect(await sent).toBe(true);
});

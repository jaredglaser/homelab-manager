import type { Page } from '@playwright/test';
import { functionIdFromUrl, resolveFunctionName } from '@/lib/mock/handlers/function-id';
import { test, expect, overrideServerFn } from './fixtures';

const VIEWER_COPY = 'Your role can view but not change things. Ask an operator or admin.';
const OPERATOR_COPY = 'Only an admin can do this.';

// Absence has no event to wait on, so the window is bounded. The admin cases prove a click is seen inside it.
function nextServerFnRequest(page: Page, name?: string): Promise<boolean> {
  const matches = (url: string) => {
    const segment = functionIdFromUrl(url);
    return segment !== null && (name === undefined || resolveFunctionName(segment) === name);
  };
  return page
    .waitForRequest((request) => matches(request.url()), { timeout: 1500 })
    .then(() => true, () => false);
}

async function openSettingsAs(page: Page, role: 'viewer' | 'operator' | 'admin') {
  await overrideServerFn(page, 'getSession', { id: 7, email: `${role}@example.com`, name: role, role });
  await page.goto('/settings');
  const check = page.getByRole('button', { name: 'check health' }).first();
  await expect(check).toBeVisible();
  return check;
}

// The button also carries the reason in a visually hidden description, so only the popup proves the tooltip opened.
const reasonTooltip = (page: Page) => page.locator('[data-slot="tooltip-content"]', { hasText: VIEWER_COPY });

test('a viewer sees Check health disabled, with the reason on hover and on keyboard focus, and a click sends nothing', async ({ page }) => {
  const check = await openSettingsAs(page, 'viewer');
  await expect(check).toHaveAttribute('aria-disabled', 'true');

  await check.hover();
  await expect(reasonTooltip(page)).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(reasonTooltip(page)).toBeHidden();

  await page.getByRole('button', { name: 'edit host' }).first().focus();
  await page.keyboard.press('Shift+Tab');
  await expect(check).toBeFocused();
  await expect(reasonTooltip(page)).toBeVisible();

  const sent = nextServerFnRequest(page, 'checkHostHealth');
  await check.click({ force: true });
  expect(await sent).toBe(false);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('a viewer sees the reason when tapping Check health, and the tap sends nothing', async ({ page }) => {
    const check = await openSettingsAs(page, 'viewer');
    await expect(check).toHaveAttribute('aria-disabled', 'true');

    const sent = nextServerFnRequest(page, 'checkHostHealth');
    await check.tap({ force: true });
    await expect(reasonTooltip(page)).toBeVisible();
    expect(await sent).toBe(false);

    await page.getByRole('heading', { name: 'Managed Hosts' }).tap();
    await expect(reasonTooltip(page)).toBeHidden();
  });
});

test('an admin can run Check health, which sends its request', async ({ page }) => {
  const check = await openSettingsAs(page, 'admin');
  await expect(check).not.toHaveAttribute('aria-disabled', 'true');

  const sent = nextServerFnRequest(page, 'checkHostHealth');
  await check.click();
  expect(await sent).toBe(true);
});

test('an operator sees Edit host disabled, with the admin-only reason on hover, and a click opens nothing and sends nothing', async ({ page }) => {
  await openSettingsAs(page, 'operator');
  const edit = page.getByRole('button', { name: 'edit host' }).first();
  await expect(edit).toHaveAttribute('aria-disabled', 'true');

  await edit.hover();
  await expect(page.locator('[data-slot="tooltip-content"]', { hasText: OPERATOR_COPY })).toBeVisible();

  const sent = nextServerFnRequest(page);
  await edit.click({ force: true });
  expect(await sent).toBe(false);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('an admin can open Edit host', async ({ page }) => {
  await openSettingsAs(page, 'admin');
  const edit = page.getByRole('button', { name: 'edit host' }).first();
  await expect(edit).not.toHaveAttribute('aria-disabled', 'true');
  await edit.click();
  await expect(page.getByRole('dialog', { name: 'Edit Host' })).toBeVisible();
});

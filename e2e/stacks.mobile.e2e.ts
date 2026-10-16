import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  // 1px of slack for sub-pixel rounding on the device scale factor.
  expect(overflow.scrollWidth, `${label} scrolls horizontally`).toBeLessThanOrEqual(
    overflow.clientWidth + 1,
  );
}

test('the stacks overview fits the viewport', async ({ page }) => {
  await page.goto('/stacks');
  await expect(page.getByText('Stacks Overview')).toBeVisible();
  await expectNoHorizontalScroll(page, '/stacks');
});

test('a stack detail view fits the viewport on every tab', async ({ page }) => {
  await page.goto('/stacks/traefik');
  await expect(page.getByRole('heading', { name: 'traefik' })).toBeVisible();
  await expectNoHorizontalScroll(page, '/stacks/traefik');

  for (const tab of ['Secrets', 'Containers', 'Deploys']) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await expectNoHorizontalScroll(page, `/stacks/traefik (${tab})`);
  }
});

test('the last tab is reachable rather than clipped', async ({ page }) => {
  await page.goto('/stacks/traefik');
  const deploysTab = page.getByRole('tab', { name: 'Deploys' });
  await deploysTab.scrollIntoViewIfNeeded();
  await deploysTab.click();
  await expect(deploysTab).toHaveAttribute('aria-selected', 'true');
  await expectNoHorizontalScroll(page, 'the tab bar');
});

test('deploy stays inline and the destructive actions live in a sheet', async ({ page }) => {
  await page.goto('/stacks/traefik');

  const deploy = page.getByRole('button', { name: 'Deploy' });
  await expect(deploy).toBeInViewport();
  const deployBox = await deploy.boundingBox();
  const viewport = page.viewportSize();
  expect(deployBox!.x + deployBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(deployBox!.height).toBeGreaterThanOrEqual(44);

  const overflow = page.getByRole('button', { name: 'More stack actions' });
  await expect(overflow).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Delete Stack' })).toHaveCount(0);

  await overflow.click();
  const deleteButton = page.getByRole('button', { name: 'Delete Stack' });
  await expect(deleteButton).toBeInViewport();
  const deleteBox = await deleteButton.boundingBox();
  expect(deleteBox!.x + deleteBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(deleteBox!.height).toBeGreaterThanOrEqual(44);

  await expect(page.getByRole('button', { name: 'Teardown' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Update images' })).toBeInViewport();
});

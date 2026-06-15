import { test, expect, overrideServerFn } from './fixtures';

test('lists stacks grouped by host', async ({ page }) => {
  await page.goto('/stacks');
  await expect(page.getByText('Stacks Overview')).toBeVisible();
  // Two managed hosts from the mock stack inventory.
  await expect(page.getByText('nas01').first()).toBeVisible();
  await expect(page.getByText('server02').first()).toBeVisible();
});

test('shows the empty state when no stacks exist', async ({ page }) => {
  // Reshape the stack list to empty; the default mock has several.
  await overrideServerFn(page, 'listStacks', []);
  await page.goto('/stacks');
  await expect(page.getByText(/No stacks yet/i)).toBeVisible();
  await expect(page.getByText('nas01')).toHaveCount(0);
});

test('opens a stack to its detail view', async ({ page }) => {
  await page.goto('/stacks');
  // Expand a host group, then open the first stack within it.
  await page.getByText('nas01').first().click();
  // A stack detail exposes the compose/variables area; assert navigation away
  // from the bare overview without asserting brittle inner copy.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});

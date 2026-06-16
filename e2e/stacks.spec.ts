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
  // The dynamic stack route drives getStackDetail + getDeployHistory against the
  // mock backend; the overview only renders per-host summaries, so the detail
  // view is reached by its own route (also how the side-nav stack links land).
  await page.goto('/stacks/traefik');

  await expect(page.getByRole('heading', { name: 'traefik' })).toBeVisible();
  // The detail view exposes the compose/secrets/containers/deploys panels.
  await expect(page.getByRole('tab', { name: 'Compose' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Secrets' })).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});

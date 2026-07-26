import { test, expect, expectLiveTextUpdate } from './fixtures';

test('renders the host/container table with a status summary', async ({ page }) => {
  await page.goto('/docker');

  // Summary chips are derived from the mocked inventory state machine.
  await expect(page.getByText(/running/).first()).toBeVisible();
  await expect(page.getByText(/hosts/).first()).toBeVisible();

  // Hosts and their containers (mock entities).
  await expect(page.getByText('192.168.1.10').first()).toBeVisible();
  await expect(page.getByText('nginx-proxy').first()).toBeVisible();
  await expect(page.getByText('plex').first()).toBeVisible();
});

test('streams live stats that change over time', async ({ page }) => {
  await page.goto('/docker');
  await expect(page.getByText('nginx-proxy').first()).toBeVisible();

  await expectLiveTextUpdate(page.locator('[data-host-id="nas01"] > div').nth(1));
});

test('a running container offers an enabled stop control', async ({ page }) => {
  await page.goto('/docker');
  await page.getByText('nginx-proxy').first().click();

  const stop = page.getByRole('button', { name: 'Stop container', disabled: false });
  await expect(stop).toHaveCount(1);
  await expect(stop).toBeVisible();
});

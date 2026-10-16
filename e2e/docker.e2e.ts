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

  await expectLiveTextUpdate(page.locator('[data-host-id="192.168.1.10"]'));
});

test('a running container offers an enabled stop control', async ({ page }) => {
  await page.goto('/docker');
  await page.getByText('nginx-proxy').first().click();

  const stop = page.getByRole('button', { name: 'Stop container', disabled: false });
  await expect(stop).toHaveCount(1);
  await expect(stop).toBeVisible();
});

test('the icon picker grid is a bounded scroll viewport', async ({ page }) => {
  await page.goto('/docker');
  await page.getByText('nginx-proxy').first().click();
  await page.getByRole('button', { name: 'Icon', exact: true }).first().click();

  const grid = page.locator('[data-slot="dialog-content"] .themed-scrollbar');
  await expect(grid).toBeVisible();

  const measure = () =>
    grid.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      cells: el.querySelectorAll('button').length,
    }));
  // The virtualizer settles over a frame after the dialog mounts; the final
  // failed assertion is the evidence when the grid never bounds.
  await expect(async () => {
    const { clientHeight, scrollHeight, cells } = await measure();
    expect(clientHeight, 'grid viewport must be bounded').toBeLessThan(610);
    expect(scrollHeight, 'grid list content must be present').toBeGreaterThan(30000);
    expect(cells, 'virtualizer must not mount every icon cell').toBeLessThan(100);
  }).toPass();
});

test('the icon picker keeps its footer visible on short viewports', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.goto('/docker');
  await page.getByText('nginx-proxy').first().click();
  await page.getByRole('button', { name: 'Icon', exact: true }).first().click();

  await expect(page.getByRole('button', { name: 'Apply' })).toBeVisible();
});

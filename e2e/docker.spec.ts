import { test, expect } from './fixtures';

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

  // The docker-stats SSE pushes a fresh snapshot ~every second. Sampling the
  // rendered metrics twice should capture movement; this is the end-to-end
  // proof that EventSource + the table merge live data, which unit tests with a
  // static fixture cannot show.
  const table = page.locator('body');
  const first = await table.innerText();
  await expect
    .poll(async () => (await table.innerText()) !== first, { timeout: 8000 })
    .toBe(true);
});

test('exposes lifecycle controls on a container row', async ({ page }) => {
  await page.goto('/docker');
  await expect(page.getByText('nginx-proxy').first()).toBeVisible();
  // A running container offers a stop control (controlContainer server fn).
  await expect(
    page.getByRole('button', { name: /stop container/i }).first(),
  ).toBeVisible();
});

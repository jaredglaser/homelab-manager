import { test, expect, expectLiveTextUpdate, overrideServerFn } from './fixtures';

test('renders the ZFS pool hierarchy', async ({ page }) => {
  await page.goto('/zfs');

  await expect(page.getByText(/pools/).first()).toBeVisible();
  await expect(page.getByText(/disks/).first()).toBeVisible();

  // Pool, then a vdev nested under it (tree data via getSubRows).
  await expect(page.getByText('nas01').first()).toBeVisible();
  await expect(page.getByText('mirror-0').first()).toBeVisible();
});

test('shows the device groups of a pool inside it, under their labels', async ({ page }) => {
  await page.goto('/zfs');

  await page.locator('[role="button"]').filter({ hasText: /^rust/ }).first().click();

  for (const label of ['Special devices', 'Dedup devices', 'Log devices', 'Cache devices', 'Spares']) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
});

test('tells the operator to update an agent too old to report ZFS stats', async ({ page }) => {
  await overrideServerFn(page, 'getHistoricalZFSStats', [{
    time: Date.now(),
    host: 'old-agent-host',
    pool: '',
    entity: '',
    entity_type: 'agent_outdated',
    indent: 0,
    capacity_alloc: null,
    capacity_free: null,
    read_ops_per_sec: null,
    write_ops_per_sec: null,
    read_bytes_per_sec: null,
    write_bytes_per_sec: null,
    utilization_percent: null,
  }]);
  await page.goto('/zfs');

  await expect(page.getByText('old-agent-host')).toBeVisible();
  await expect(
    page.getByText("This host's agent is too old to report ZFS stats. Update the agent from the Hosts page.", { exact: true }),
  ).toBeVisible();
});

test('streams live ZFS stats that change over time', async ({ page }) => {
  await page.goto('/zfs');
  await expect(page.getByText('nas01').first()).toBeVisible();

  await expectLiveTextUpdate(
    page.locator('[role="button"]').filter({ hasText: 'nas01' }),
  );
});

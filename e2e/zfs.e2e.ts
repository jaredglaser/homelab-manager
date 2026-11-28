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

test('shows the demo pool health word for word: chips, the degraded banner, error counts and scrub lines', async ({ page }) => {
  // Tall enough that the expanded pool's last disks sit above the speed charts.
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.goto('/zfs');

  await expect(page.getByText('rust on nas01 is degraded. A device has failed or is missing, so the pool has lost redundancy. Your data is still readable.', { exact: true })).toBeVisible();
  await expect(page.getByText('Scrub running, 42% done', { exact: true })).toBeVisible();
  await expect(page.getByText('Never scrubbed', { exact: true })).toBeVisible();
  const lastScrub = await page.evaluate(() => new Date(Date.now() - 4 * 24 * 60 * 60_000).toLocaleDateString([], { month: 'short', day: 'numeric' }));
  await expect(page.getByText(`Last scrub ${lastScrub}, repaired 0 B, 0 errors`, { exact: true })).toBeVisible();

  await page.locator('[role="button"]').filter({ hasText: /^rust/ }).first().click();
  await expect(page.getByText('Degraded', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Online', { exact: true }).first()).toBeVisible();
  // A hover that lands while the pool's rows are still opening leaves the tooltip shut, so it is retried.
  await expect(async () => {
    await page.mouse.move(0, 0);
    await page.getByText('Faulted', { exact: true }).hover();
    await expect(page.getByText('3 read, 0 write and 12 checksum errors since the counters were last cleared.', { exact: true })).toBeVisible({ timeout: 1500 });
  }).toPass();
});

test('shows the faulted banner, the host notices and every other state and scrub line word for word', async ({ page }) => {
  const now = Date.now();
  const statsRow = (host: string, pool: string, entity: string, entityType: 'pool' | 'vdev' | 'disk') => ({
    time: now,
    host,
    pool,
    entity,
    entity_type: entityType,
    indent: (entity.split('/').length - 1) * 2,
    capacity_alloc: entityType === 'disk' ? null : 100,
    capacity_free: entityType === 'disk' ? null : 300,
    read_ops_per_sec: 1,
    write_ops_per_sec: 1,
    read_bytes_per_sec: 1,
    write_bytes_per_sec: 1,
    utilization_percent: null,
  });
  await overrideServerFn(page, 'getHistoricalZFSStats', [
    statsRow('pve2', 'vault', 'vault', 'pool'),
    statsRow('pve2', 'vault', 'vault/sda', 'disk'),
    ...['cold', 'arch', 'old'].flatMap((pool) => [statsRow('pve3', pool, pool, 'pool'), statsRow('pve3', pool, `${pool}/sda`, 'disk')]),
  ]);
  await page.addInitScript(() => {
    const day = (d: number) => new Date(2026, 10, d, 4).getTime();
    const errors = { read: 0, write: 0, checksum: 0 };
    const disk = (entity: string, state: string) => ({ entity, entityType: 'disk', state, errors });
    const onlinePool = (pool: string, scan: unknown) => ({
      pool,
      scan,
      nodes: [{ entity: pool, entityType: 'pool', state: 'online', errors: null }, disk(`${pool}/sda`, 'online')],
    });
    (window as unknown as { __mockZfsHealth: unknown }).__mockZfsHealth = [
      {
        host: 'pve1',
        readable: true,
        connected: false,
        lastSeenAt: new Date(2026, 10, 27, 10, 42).getTime(),
        pools: [{
          pool: 'tank',
          scan: { kind: 'resilver', state: 'running', percentDone: 42, endedAt: null, repairedBytes: 0, errors: 0 },
          nodes: [
            { entity: 'tank', entityType: 'pool', state: 'faulted', errors: null },
            { entity: 'tank/mirror-0', entityType: 'vdev', state: 'faulted', errors },
            disk('tank/mirror-0/sda', 'offline'),
            disk('tank/mirror-0/sdb', 'unavailable'),
            disk('tank/mirror-0/sdc', 'removed'),
          ],
        }],
      },
      {
        host: 'pve2',
        readable: false,
        connected: true,
        lastSeenAt: Date.now(),
        pools: [{
          pool: 'vault',
          scan: { kind: 'scrub', state: 'paused', percentDone: 42, endedAt: null, repairedBytes: 0, errors: 0 },
          nodes: [{ entity: 'vault', entityType: 'pool', state: 'suspended', errors: null }, disk('vault/sda', 'online')],
        }],
      },
      {
        host: 'pve3',
        readable: true,
        connected: true,
        lastSeenAt: Date.now(),
        pools: [
          onlinePool('cold', { kind: 'resilver', state: 'finished', percentDone: null, endedAt: day(23), repairedBytes: 1.5 * 1024 ** 3, errors: 0 }),
          onlinePool('arch', { kind: 'scrub', state: 'canceled', percentDone: null, endedAt: day(23), repairedBytes: 0, errors: 0 }),
          onlinePool('old', { kind: 'resilver', state: 'canceled', percentDone: null, endedAt: day(23), repairedBytes: 0, errors: 0 }),
        ],
      },
    ];
  });
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.goto('/zfs');

  await expect(page.getByText('tank on pve1 is faulted. Data on this pool may be unavailable.', { exact: true })).toBeVisible();
  await expect(page.getByText('vault on pve2 is faulted. Data on this pool may be unavailable.', { exact: true })).toBeVisible();
  await expect(page.getByText('pve1 is offline. Showing pool health from 10:42.', { exact: true })).toBeVisible();
  await expect(page.getByText("Can't read pool health from pve2. I/O stats are still live.", { exact: true })).toBeVisible();
  for (const chip of ['Faulted', 'Offline', 'Unavailable', 'Removed', 'Suspended']) {
    await expect(page.getByText(chip, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText('Resilvering, 42% done', { exact: true })).toBeVisible();
  await expect(page.getByText('Scrub paused, 42% done', { exact: true })).toBeVisible();

  await page.locator('[role="button"]').filter({ hasText: /^pve3/ }).first().click();
  await expect(page.getByText('Last resilver Nov 23, repaired 1.5 GiB, 0 errors', { exact: true })).toBeVisible();
  await expect(page.getByText('Scrub canceled Nov 23', { exact: true })).toBeVisible();
  await expect(page.getByText('Resilver canceled Nov 23', { exact: true })).toBeVisible();
});

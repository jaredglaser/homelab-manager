import type { Page } from '@playwright/test';
import type { ProxmoxCollectorStateView } from '@/types/proxmox';
import { test, expect } from './fixtures';

// Seeds the mock mux before the page loads (src/lib/mock/handlers/ws.ts reads these globals).
async function seedProxmoxState(page: Page, connections: ProxmoxCollectorStateView[]): Promise<void> {
  await page.addInitScript((value) => {
    (window as unknown as { __mockProxmoxState: unknown }).__mockProxmoxState = value;
  }, connections);
}

function connection(overrides: Partial<ProxmoxCollectorStateView>): ProxmoxCollectorStateView {
  return {
    connectionId: 'pve.lan',
    host: 'pve.lan',
    port: 8006,
    state: 'collecting',
    lastSuccessAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

test('renders the Proxmox cluster, nodes, and guests', async ({ page }) => {
  await page.goto('/proxmox');

  await expect(page.getByText(/nodes/).first()).toBeVisible();
  await expect(page.getByText(/VMs/).first()).toBeVisible();

  // Cluster summary and a node from the mock.
  await expect(page.getByText('homelab').first()).toBeVisible();
  await expect(page.getByText('pve1').first()).toBeVisible();
});

test('keeps the cluster summary cards and the node CPU, memory and disk', async ({ page }) => {
  await page.goto('/proxmox');

  await expect(page.getByText('2/2 nodes online')).toBeVisible();
  await expect(page.getByText(/^[\d.]+ \/ 8 cores$/)).toBeVisible();
  await expect(page.getByText('4 running')).toBeVisible();
  await expect(page.getByText('2 VMs, 2 CTs')).toBeVisible();
  for (const label of ['Cluster', 'CPU', 'Memory', 'Guests']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }

  const node = page.getByRole('button', { name: /pve1/ }).first();
  await expect(node).toContainText(/CPU: [\d.]+%/);
  await expect(node).toContainText(/Mem: [\d.]+%/);
  await expect(node).toContainText(/Disk: [\d.]+%/);
});

test('heads the guest rate columns Net in, Net out, Disk read and Disk write, with live rates', async ({ page }) => {
  await page.goto('/proxmox');
  await expect(page.getByText('ubuntu-server')).toBeVisible();

  for (const header of ['Net in', 'Net out', 'Disk read', 'Disk write']) {
    await expect(page.getByText(header, { exact: true }).first()).toBeVisible();
  }
  const guestRow = page.locator('.group.grid', { hasText: 'ubuntu-server' });
  const rates = /\d[\d.]*\s*(?:[KMGT]i?)?(?:B\/s|bps|\/s)/g;
  await expect.poll(async () => ((await guestRow.textContent())?.match(rates) ?? []).length).toBe(4);
});

test.describe('worker state messages', () => {
  const cases: [string, ProxmoxCollectorStateView[], string][] = [
    ['no connection is set up', [], "Proxmox isn't set up. Add your cluster in Settings, under Proxmox."],
    [
      'the collector is off',
      [connection({ state: 'collector_off' })],
      "The worker isn't collecting Proxmox stats. Set WORKER_PROXMOX_ENABLED=true on the worker container and restart it.",
    ],
    [
      'Proxmox rejects the token',
      [connection({ state: 'token_rejected' })],
      'Proxmox rejected the API token. Check the token ID and secret, and that the token can read the cluster.',
    ],
    [
      'the certificate is refused',
      [connection({ state: 'certificate_refused' })],
      "Proxmox's certificate isn't trusted. Allow self-signed certificates for this connection, or give Proxmox a trusted certificate.",
    ],
  ];

  for (const [when, connections, message] of cases) {
    test(`shows the accepted message when ${when}`, async ({ page }) => {
      await seedProxmoxState(page, connections);
      await page.goto('/proxmox');
      await expect(page.getByRole('alert').filter({ hasText: message })).toHaveText(message);
    });
  }

  test('shows the address and the last data time when Proxmox is unreachable, with the data still on screen', async ({ page }) => {
    const lastSuccessAt = await page.evaluate(() => new Date(2026, 10, 27, 10, 42).getTime());
    await seedProxmoxState(page, [connection({ state: 'unreachable', lastSuccessAt })]);
    await page.goto('/proxmox');

    const message = "Can't reach Proxmox at pve.lan:8006. Showing the last data, from 10:42.";
    await expect(page.getByRole('alert').filter({ hasText: "Can't reach" })).toHaveText(message);
    await expect(page.getByText('ubuntu-server')).toBeVisible();
  });

  test('shows the lost live connection message when the live stream fails', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __mockMuxTopicErrors: string[] }).__mockMuxTopicErrors = ['stats:proxmox'];
    });
    await page.goto('/proxmox');

    const message = 'Lost the live connection. Reconnecting…';
    await expect(page.getByRole('alert').filter({ hasText: 'Lost the live connection' })).toHaveText(message);
  });
});

import { test, expect } from './fixtures';

test('renders the Proxmox cluster, nodes, and guests', async ({ page }) => {
  await page.goto('/proxmox');

  await expect(page.getByText(/nodes/).first()).toBeVisible();
  await expect(page.getByText(/VMs/).first()).toBeVisible();

  // Cluster summary and a node from the mock.
  await expect(page.getByText('homelab').first()).toBeVisible();
  await expect(page.getByText('pve1').first()).toBeVisible();
});

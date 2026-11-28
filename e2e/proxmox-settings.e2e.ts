import type { Locator, Page } from '@playwright/test';
import { test, expect, overrideServerFn } from './fixtures';

async function openProxmoxSettings(page: Page, role: 'viewer' | 'operator' | 'admin' = 'admin'): Promise<Locator> {
  await overrideServerFn(page, 'getSession', { id: 7, email: `${role}@example.com`, name: role, role });
  await page.goto('/settings#proxmox');
  const section = page.locator('#proxmox');
  await expect(section.getByText('homelab', { exact: true })).toBeVisible();
  return section;
}

async function fillNewCluster(page: Page, section: Locator): Promise<Locator> {
  await section.getByRole('button', { name: 'Add cluster' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Address').fill('pve.lan');
  await dialog.getByLabel('Token ID (user@realm!token)').fill('root@pam!homelab-manager');
  await dialog.getByLabel('Token secret').fill('12345678-1234-1234-1234-123456789012');
  return dialog;
}

test('labels the Proxmox form fields, and offers to keep the stored secret when editing', async ({ page }) => {
  const section = await openProxmoxSettings(page);

  await section.getByRole('button', { name: 'Add cluster' }).click();
  const add = page.getByRole('dialog');
  for (const label of ['Address', 'Port', 'Token ID (user@realm!token)', 'Token secret', 'Allow self-signed certificate']) {
    await expect(add.getByText(label, { exact: true })).toBeVisible();
  }
  await add.getByRole('button', { name: 'Cancel' }).click();
  await expect(add).toBeHidden();

  await section.getByRole('button', { name: 'Edit homelab' }).click();
  await expect(page.getByRole('dialog').getByText('Stored encrypted. Leave blank to keep the current secret.', { exact: true })).toBeVisible();
});

test('reports the cluster Test connection reached, then saves with the accepted toast', async ({ page }) => {
  const section = await openProxmoxSettings(page);
  const dialog = await fillNewCluster(page, section);

  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByText('Connected to homelab (Proxmox VE 9.0), 2 nodes.', { exact: true })).toBeVisible();

  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('[data-sonner-toast]', { hasText: 'Proxmox cluster saved. Stats start within a few seconds.' })).toBeVisible();
  await expect(dialog).toBeHidden();
});

test.describe('Test connection failures', () => {
  const cases = [
    ['unreachable', "Couldn't reach pve.lan on port 8006. Check the address and that the port is open from the server running Homelab Manager."],
    ['token_rejected', 'Proxmox rejected the token. Check the token ID and secret.'],
    ['certificate_refused', "Proxmox's certificate isn't trusted. Turn on \"Allow self-signed certificate\" or give Proxmox a trusted certificate."],
  ] as const;

  for (const [code, message] of cases) {
    test(`words a ${code} result for the user`, async ({ page }) => {
      await overrideServerFn(page, 'testProxmoxConnection', { ok: false, code });
      const section = await openProxmoxSettings(page);
      const dialog = await fillNewCluster(page, section);

      await dialog.getByRole('button', { name: 'Test connection' }).click();
      await expect(dialog.getByText(message, { exact: true })).toBeVisible();
    });
  }
});

test('asks before removing a cluster, in the accepted words', async ({ page }) => {
  const section = await openProxmoxSettings(page);

  await section.getByRole('button', { name: 'Remove homelab' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Remove homelab? Its history stays, but no new stats are collected.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(dialog).toBeHidden();
});

test('shows a viewer the cluster with every change disabled and the admin-only reason', async ({ page }) => {
  const section = await openProxmoxSettings(page, 'viewer');
  const add = section.getByRole('button', { name: 'Add cluster' });

  await expect(add).toHaveAttribute('aria-disabled', 'true');
  await expect(section.getByRole('button', { name: 'Edit homelab' })).toHaveAttribute('aria-disabled', 'true');
  await expect(section.getByRole('button', { name: 'Remove homelab' })).toHaveAttribute('aria-disabled', 'true');
  await add.hover();
  await expect(page.locator('[data-slot="tooltip-content"]', { hasText: 'Only admins can change Proxmox connections.' })).toBeVisible();
});

test('the not-set-up notice names the Settings section that exists', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __mockProxmoxState: unknown }).__mockProxmoxState = [];
  });
  await page.goto('/proxmox');
  await expect(page.getByRole('alert').filter({ hasText: "Proxmox isn't set up." })).toHaveText(
    "Proxmox isn't set up. Add your cluster in Settings, under Proxmox.",
  );
  await page.goto('/settings#proxmox');
  await expect(page.locator('#proxmox').getByText('Proxmox', { exact: true })).toBeVisible();
});

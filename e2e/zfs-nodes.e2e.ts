import { test, expect, overrideServerFn } from './fixtures';
import type { ZfsNodeState, ZfsNodeSummary } from '@/lib/zfs/node-state';
import { MOCK_HOST_KEY_FINGERPRINT } from '@/lib/mock/functions/zfs.functions';

test.use({ timezoneId: 'UTC' });

const W1 = "Run this on the node as root. It adds a user named hlm that can read your pools but cannot change them, and allows only this app's key to run two read-only ZFS commands.";
const W2 = `Confirm this is pve1's host key: ${MOCK_HOST_KEY_FINGERPRINT} Compare it with the output of the last line of the setup script.`;
const W3 = 'Connected to pve1. Found 2 pools: rpool, tank.';
const W4 = "Can't reach pve1 over SSH on port 22. Showing the last data, from 10:42.";
const W5 = "pve1's host key changed, so collection stopped. If you reinstalled the node, confirm the new key on the Hosts page. If not, something may be impersonating it.";
const W6 = "pve1 refused the app's key. Run the setup script on the node again.";
const W7 = 'pve1 is missing zpool_influxdb, which comes with ZFS. Update the zfsutils-linux package on the node.';
const W8 = 'ZFS is no longer read through the agent. Add this machine as a ZFS node to see its pools.';
const TIMEOUT = 'pve1 stopped answering ZFS reads, so a pool may be suspended or a disk may be hanging. Check zpool status on the node. Showing the last data, from 10:42.';
const READ_FAILED = 'Reading ZFS on pve1 failed. Run the setup script on the node again, then check the worker logs if it keeps failing. Showing the last data, from 10:42.';
const PENDING = 'Waiting for the host key to be confirmed. Collection starts after that.';
const NO_POOLS = 'Connected to pve1. Found no pools.';
const REMOVE = "Remove pve1? Collection stops at once and its stored history is kept. To revoke the app's key on the node, run userdel hlm there.";

function node(state: ZfsNodeState): ZfsNodeSummary {
  return {
    id: 1,
    name: 'pve1',
    address: '192.168.1.30',
    port: 22,
    allowedFrom: null,
    state,
    hostKeyFingerprint: MOCK_HOST_KEY_FINGERPRINT,
    seenHostKeyFingerprint: state === 'host_key_changed' ? 'SHA256:AnotherKeyAnotherKeyAnotherKeyAnotherKeyAno' : null,
    lastSuccessAt: Date.UTC(2026, 10, 27, 10, 42),
  };
}

test('adds a ZFS node: setup script, host key confirm, connected', async ({ page }) => {
  await page.goto('/hosts');
  await page.getByRole('button', { name: 'Add ZFS node' }).click();
  await page.getByLabel('Name', { exact: true }).fill('pve1');
  await page.getByLabel('Address', { exact: true }).fill('192.168.1.40');
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByTestId('zfs-setup-intro')).toHaveText(W1);
  await expect(page.getByTestId('zfs-setup-script')).toContainText('restrict,command="/usr/local/libexec/homelab-manager/zfs-read"');
  await page.getByRole('button', { name: 'I ran it, connect' }).click();

  await expect(page.getByTestId('zfs-host-key-confirm')).toHaveText(W2);
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByTestId('zfs-node-connected')).toHaveText(W3);
});

for (const [state, message, onHostsPage] of [
  ['unreachable', W4, true],
  ['host_key_changed', W5, true],
  ['key_refused', W6, true],
  ['influxdb_missing', W7, false],
  ['timeout', TIMEOUT, true],
  ['error', READ_FAILED, true],
  ['pending', PENDING, true],
] as const) {
  test(`shows the ${state} notice on the ZFS page host row${onHostsPage ? ' and the Hosts page' : ''}`, async ({ page }) => {
    await overrideServerFn(page, 'listZfsNodes', [node(state)]);
    await page.goto('/zfs');
    await expect(page.getByTestId('zfs-node-notice-pve1')).toHaveText(message);

    if (onHostsPage) {
      await page.goto('/hosts');
      await expect(page.getByTestId('zfs-node-notice-pve1')).toHaveText(message);
    }
  });
}

test('tells the user to add a ZFS node for an agent that still has ZFS turned on', async ({ page }) => {
  await overrideServerFn(page, 'listAgentsInventory', [{
    id: 2,
    name: 'media-server',
    agentUrl: 'https://192.168.1.20:9090',
    capabilities: { docker: true, zfs: true },
    status: 'online',
    version: '0.1.0',
    agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
    agentImageTag: 'latest',
    agentImageDigest: 'sha256:' + 'a'.repeat(64),
    agentOutOfDate: false,
    failure: null,
    checkedAt: new Date().toISOString(),
  }]);
  await page.goto('/hosts');
  await expect(page.getByTestId('agent-zfs-moved-media-server')).toHaveText(W8);
});

test('reports a node with no pools on the verify step', async ({ page }) => {
  await overrideServerFn(page, 'confirmZfsNodeHostKey', { ok: true, pools: [] });
  await page.goto('/hosts');
  await page.getByRole('button', { name: 'Add ZFS node' }).click();
  await page.getByLabel('Name', { exact: true }).fill('pve1');
  await page.getByLabel('Address', { exact: true }).fill('192.168.1.40');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'I ran it, connect' }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByTestId('zfs-node-connected')).toHaveText(NO_POOLS);
});

test('says what removing a node does before it removes it', async ({ page }) => {
  await overrideServerFn(page, 'listZfsNodes', [node('ok')]);
  await page.goto('/hosts');
  await page.getByRole('button', { name: 'Remove pve1' }).click();
  await expect(page.getByText(REMOVE, { exact: true })).toBeVisible();
});

import { describe, expect, test } from 'bun:test';
import {
  AGENT_ZFS_MOVED_MESSAGE,
  SETUP_SCRIPT_INTRO,
  ZFS_NODE_PENDING_MESSAGE,
  connectedMessage,
  formatNoticeTime,
  hostKeyConfirmMessage,
  zfsNodeNotice,
  type ZfsNodeState,
} from '../node-state';

const at1042 = new Date(2026, 10, 27, 10, 42).getTime();
const time = (ms: number) => formatNoticeTime(ms, false);

function notice(state: ZfsNodeState, lastSuccessAt: number | null = at1042) {
  return zfsNodeNotice({ name: 'pve1', port: 22, state, lastSuccessAt }, time);
}

describe('ZFS node copy', () => {
  test('w1 setup step', () => {
    expect(SETUP_SCRIPT_INTRO).toBe(
      "Run this on the node as root. It adds a user named hlm that can read your pools but cannot change them, and allows only this app's key to run two read-only ZFS commands.",
    );
  });

  test('w2 host key confirm', () => {
    expect(hostKeyConfirmMessage('pve1', 'SHA256:abc123...')).toBe(
      "Confirm this is pve1's host key: SHA256:abc123... Compare it with the output of the last line of the setup script.",
    );
  });

  test('w3 connected', () => {
    expect(connectedMessage('pve1', ['rpool', 'tank'])).toBe('Connected to pve1. Found 2 pools: rpool, tank.');
    expect(connectedMessage('pve1', ['tank'])).toBe('Connected to pve1. Found 1 pool: tank.');
    expect(connectedMessage('pve1', [])).toBe('Connected to pve1. Found no pools.');
  });

  test('w4 unreachable, with and without earlier data', () => {
    expect(notice('unreachable')).toBe("Can't reach pve1 over SSH on port 22. Showing the last data, from 10:42.");
    expect(notice('unreachable', null)).toBe("Can't reach pve1 over SSH on port 22.");
  });

  test('w5 host key changed', () => {
    expect(notice('host_key_changed')).toBe(
      "pve1's host key changed, so collection stopped. If you reinstalled the node, confirm the new key on the Hosts page. If not, something may be impersonating it.",
    );
  });

  test('w6 key refused', () => {
    expect(notice('key_refused')).toBe("pve1 refused the app's key. Run the setup script on the node again.");
  });

  test('w7 zpool_influxdb missing', () => {
    expect(notice('influxdb_missing')).toBe(
      'pve1 is missing zpool_influxdb, which comes with ZFS. Update the zfsutils-linux package on the node.',
    );
  });

  test('w8 agent still flagged with ZFS', () => {
    expect(AGENT_ZFS_MOVED_MESSAGE).toBe('ZFS is no longer read through the agent. Add this machine as a ZFS node to see its pools.');
  });

  test('notices for a hung read, a failed read and a node waiting for a confirm', () => {
    expect(notice('timeout')).toBe(
      'pve1 stopped answering ZFS reads, so a pool may be suspended or a disk may be hanging. Check zpool status on the node. Showing the last data, from 10:42.',
    );
    expect(notice('error')).toBe(
      'Reading ZFS on pve1 failed. Run the setup script on the node again, then check the worker logs if it keeps failing. Showing the last data, from 10:42.',
    );
    expect(notice('pending')).toBe(ZFS_NODE_PENDING_MESSAGE);
    expect(ZFS_NODE_PENDING_MESSAGE).toBe('Waiting for the host key to be confirmed. Collection starts after that.');
    expect(notice('ok')).toBeNull();
  });
});

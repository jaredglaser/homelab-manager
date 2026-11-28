export const ZFS_NODE_STATES = [
  'pending',
  'ok',
  'unreachable',
  'host_key_changed',
  'key_refused',
  'influxdb_missing',
  'timeout',
  'error',
  'key_unreadable',
  'no_ed25519_key',
] as const;
export type ZfsNodeState = (typeof ZFS_NODE_STATES)[number];

/** A ZFS node as every page sees it. Never carries the private key. */
export interface ZfsNodeSummary {
  id: number;
  name: string;
  address: string;
  port: number;
  allowedFrom: string | null;
  state: ZfsNodeState;
  /** SHA256 fingerprint the user confirmed, or null before the first confirm. */
  hostKeyFingerprint: string | null;
  /** The fingerprint the node presented when it did not match the pinned one, waiting for a confirm. */
  seenHostKeyFingerprint: string | null;
  /** Epoch ms of the last sample read, or null if none was. */
  lastSuccessAt: number | null;
}

export type ZfsNodeFailure = Exclude<ZfsNodeState, 'pending' | 'ok'>;

function lastData(lastSuccessAt: number | null, formatTime: (ms: number) => string): string {
  return lastSuccessAt === null ? '' : ` Showing the last data, from ${formatTime(lastSuccessAt)}.`;
}

export function hostKeyConfirmMessage(name: string, fingerprint: string): string {
  return `Confirm this is ${name}'s host key: ${fingerprint} Compare it with the output of the last line of the setup script.`;
}

export function connectedMessage(name: string, pools: readonly string[]): string {
  if (pools.length === 0) return `Connected to ${name}. Found no pools.`;
  return `Connected to ${name}. Found ${pools.length} pool${pools.length === 1 ? '' : 's'}: ${pools.join(', ')}.`;
}

export const SETUP_SCRIPT_INTRO =
  'Run this on the node as root. It adds a user named hlm that can read your pools but cannot change them, and allows only this app\'s key to run two read-only ZFS commands.';

export const AGENT_ZFS_MOVED_MESSAGE =
  'ZFS is no longer read through the agent. Add this machine as a ZFS node to see its pools.';

export const ZFS_NODE_PENDING_MESSAGE = 'Waiting for the host key to be confirmed. Collection starts after that.';

export function zfsNodeNotice(
  node: Pick<ZfsNodeSummary, 'name' | 'port' | 'state' | 'lastSuccessAt'>,
  formatTime: (ms: number) => string,
): string | null {
  const { name, port, lastSuccessAt } = node;
  switch (node.state) {
    case 'ok':
      return null;
    case 'pending':
      return ZFS_NODE_PENDING_MESSAGE;
    case 'unreachable':
      return `Can't reach ${name} over SSH on port ${port}.${lastData(lastSuccessAt, formatTime)}`;
    case 'host_key_changed':
      return `${name}'s host key changed, so collection stopped. If you reinstalled the node, confirm the new key on the Hosts page. If not, something may be impersonating it.`;
    case 'key_refused':
      return `${name} refused the app's key. Run the setup script on the node again.`;
    case 'influxdb_missing':
      return `${name} is missing zpool_influxdb, which comes with ZFS. Update the zfsutils-linux package on the node.`;
    case 'timeout':
      return `${name} stopped answering ZFS reads, so a pool may be suspended or a disk may be hanging. Check zpool status on the node.${lastData(lastSuccessAt, formatTime)}`;
    case 'error':
      return `Reading ZFS on ${name} failed. Run the setup script on the node again, then check the worker logs if it keeps failing.${lastData(lastSuccessAt, formatTime)}`;
    case 'no_ed25519_key':
      return `${name} has no ed25519 SSH host key, which the app needs. Run ssh-keygen -A on the node as root, then run the setup script again.`;
    case 'key_unreadable':
      return `The app can't read its saved key for ${name}, so collection stopped. Check that the worker has the master key the key was saved with.`;
  }
}

export function formatNoticeTime(ms: number, use12HourTime: boolean): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: use12HourTime });
}

/** w8 shows for an agent left with the old ZFS flag until a ZFS node has the agent's name or its URL's host. */
export function agentNeedsZfsNode(
  agent: { name: string; agentUrl: string; capabilities: { docker?: boolean; zfs?: boolean } },
  nodes: readonly Pick<ZfsNodeSummary, 'name' | 'address'>[],
): boolean {
  if (!agent.capabilities.zfs) return false;
  let agentHost: string | null = null;
  try {
    agentHost = new URL(agent.agentUrl).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  } catch {
    agentHost = null;
  }
  return !nodes.some((node) =>
    node.name.toLowerCase() === agent.name.toLowerCase()
    || (agentHost !== null && node.address.replace(/^\[(.*)\]$/, '$1').toLowerCase() === agentHost));
}

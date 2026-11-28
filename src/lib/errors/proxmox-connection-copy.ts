import type { SaveProxmoxConnectionResult, TestProxmoxConnectionResult } from '@/data/proxmox/connection-handlers';

export const PROXMOX_FIELD_LABELS = {
  address: 'Address',
  port: 'Port',
  tokenId: 'Token ID (user@realm!token)',
  tokenSecret: 'Token secret',
  allowSelfSigned: 'Allow self-signed certificate',
} as const;

export const PROXMOX_SECRET_KEPT_HINT = 'Stored encrypted. Leave blank to keep the current secret.';
export const PROXMOX_TOKEN_REJECTED_TEST = 'Proxmox rejected the token. Check the token ID and secret.';
export const PROXMOX_CERTIFICATE_REFUSED_TEST =
  "Proxmox's certificate isn't trusted. Turn on \"Allow self-signed certificate\" or give Proxmox a trusted certificate.";
export const PROXMOX_SAVED_TOAST = 'Proxmox cluster saved. Stats start within a few seconds.';
export const PROXMOX_ADMIN_ONLY = 'Only admins can change Proxmox connections.';

export const PROXMOX_NO_CONNECTIONS = 'No Proxmox cluster added yet.';
export const PROXMOX_COLLECTING = 'Collecting';
export const PROXMOX_INVALID_ADDRESS = 'Enter a host name or IP address, without https:// or a port.';
export const PROXMOX_INVALID_PORT = 'Enter a port from 1 to 65535.';
export const PROXMOX_INVALID_TOKEN = 'Use only letters, digits and symbols, with no spaces.';
export const PROXMOX_CONNECTION_GONE = 'This Proxmox connection was removed, maybe from another tab. Close this form and add it again.';
export const PROXMOX_SAVE_FAILED = "Couldn't save the Proxmox connection. Try again.";
export const PROXMOX_TEST_FAILED = "Couldn't run the test. Try again.";

export function proxmoxTestSucceeded(clusterName: string, release: string, nodeCount: number): string {
  return `Connected to ${clusterName} (Proxmox VE ${release}), ${nodeCount} ${nodeCount === 1 ? 'node' : 'nodes'}.`;
}

export function proxmoxUnreachable(address: string, port: number): string {
  return `Couldn't reach ${address} on port ${port}. Check the address and that the port is open from the server running Homelab Manager.`;
}

export function proxmoxRemoveQuestion(name: string): string {
  return `Remove ${name}? Its history stays, but no new stats are collected.`;
}

export function proxmoxRemoveFailed(name: string): string {
  return `Couldn't remove ${name}. Try again.`;
}

export function proxmoxAddressTaken(address: string): string {
  return `A Proxmox connection to ${address} already exists.`;
}

export function proxmoxTestMessage(result: TestProxmoxConnectionResult, address: string, port: number): string {
  if (result.ok) return proxmoxTestSucceeded(result.clusterName, result.release, result.nodeCount);
  switch (result.code) {
    case 'unreachable':
      return proxmoxUnreachable(address, port);
    case 'token_rejected':
      return PROXMOX_TOKEN_REJECTED_TEST;
    case 'certificate_refused':
      return PROXMOX_CERTIFICATE_REFUSED_TEST;
    case 'not_found':
      return PROXMOX_CONNECTION_GONE;
  }
}

export function proxmoxSaveFailure(result: Extract<SaveProxmoxConnectionResult, { ok: false }>, address: string): string {
  return result.code === 'address_taken' ? proxmoxAddressTaken(address) : PROXMOX_CONNECTION_GONE;
}

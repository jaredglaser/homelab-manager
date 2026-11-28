import { describe, it, expect } from 'bun:test';
import { proxmoxStateChannel } from '../proxmox-state';

const connection = {
  connectionId: 'pve.lan',
  host: 'pve.lan',
  port: 8006,
  state: 'unreachable',
  lastSuccessAt: 1_700_000_000_000,
  updatedAt: 1_700_000_060_000,
};

describe('proxmoxStateChannel', () => {
  it('rides the proxmox-state topic', () => {
    expect(proxmoxStateChannel.topic).toBe('proxmox-state');
  });

  it('accepts a snapshot of recorded connections, and an empty one for no connection set up', () => {
    expect(proxmoxStateChannel.schema.safeParse({ connections: [connection] }).success).toBe(true);
    expect(proxmoxStateChannel.schema.safeParse({ connections: [] }).success).toBe(true);
  });

  it('drops a reason, which never goes to the browser', () => {
    const parsed = proxmoxStateChannel.schema.parse({ connections: [{ ...connection, reason: 'HTTP 500 secret detail' }] });
    expect('reason' in parsed.connections[0]).toBe(false);
  });

  it('rejects a state the page has no notice for', () => {
    expect(proxmoxStateChannel.schema.safeParse({ connections: [{ ...connection, state: 'bogus' }] }).success).toBe(false);
  });
});

import { describe, it, expect } from 'bun:test';
import { buildAnsibleInventory } from '@/lib/ansible/inventory';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';

function host(overrides: Partial<ManagedHost> & { name: string }): ManagedHost {
  return {
    id: 1,
    agentUrl: `https://${overrides.name}.example:9090`,
    capabilities: {},
    agentVersion: null,
    agentImage: null,
    agentImageTag: null,
    sshHost: null,
    sshUser: null,
    status: 'healthy',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const options = { remoteUser: 'ansible', appdataRoot: '/srv/appdata', selfHostName: null };

describe('buildAnsibleInventory', () => {
  it('emits an empty but valid inventory for no hosts', () => {
    expect(buildAnsibleInventory([], options)).toEqual({
      _meta: { hostvars: {} },
      all: { children: ['ungrouped'] },
      ungrouped: { hosts: [] },
    });
  });

  it('sorts hosts by name and populates _meta.hostvars for every one', () => {
    const inventory = buildAnsibleInventory(
      [host({ name: 'host-b' }), host({ name: 'host-a' })],
      options,
    );

    expect(Object.keys(inventory._meta.hostvars)).toEqual(['host-a', 'host-b']);
    expect(inventory._meta.hostvars['host-a']).toEqual({
      ansible_host: 'host-a.example',
      ansible_user: 'ansible',
      hlm_appdata_root: '/srv/appdata',
      hlm_host_status: 'healthy',
      hlm_self_managed: false,
    });
  });

  it('derives ansible_host from the agent URL and falls back to the name when it is unparseable', () => {
    const inventory = buildAnsibleInventory(
      [
        host({ name: 'host-a', agentUrl: 'https://10.0.0.5:9090/api' }),
        host({ name: 'host-b', agentUrl: 'not a url' }),
      ],
      options,
    );

    expect(inventory._meta.hostvars['host-a'].ansible_host).toBe('10.0.0.5');
    expect(inventory._meta.hostvars['host-b'].ansible_host).toBe('host-b');
  });

  it('prefers the host ssh_host over the agent URL', () => {
    const inventory = buildAnsibleInventory(
      [
        host({ name: 'host-a', agentUrl: 'https://agent.lan', sshHost: '192.168.1.50' }),
        host({ name: 'host-b', agentUrl: 'http://localhost:9090', sshHost: 'host.docker.internal' }),
      ],
      options,
    );

    expect(inventory._meta.hostvars['host-a'].ansible_host).toBe('192.168.1.50');
    expect(inventory._meta.hostvars['host-b'].ansible_host).toBe('host.docker.internal');
  });

  it('ignores a whitespace-only ssh_host and falls through to the agent URL', () => {
    const inventory = buildAnsibleInventory(
      [host({ name: 'host-a', agentUrl: 'https://10.0.0.5:9090', sshHost: '   ' })],
      options,
    );

    expect(inventory._meta.hostvars['host-a'].ansible_host).toBe('10.0.0.5');
  });

  it('trims an ssh_host with surrounding whitespace', () => {
    const inventory = buildAnsibleInventory(
      [host({ name: 'host-a', sshHost: '  nas.lan  ' })],
      options,
    );

    expect(inventory._meta.hostvars['host-a'].ansible_host).toBe('nas.lan');
  });

  it('uses the per-host ssh_user and falls back to remoteUser for hosts without one', () => {
    const inventory = buildAnsibleInventory(
      [
        host({ name: 'host-a', sshUser: 'root' }),
        host({ name: 'host-b' }),
        host({ name: 'host-c', sshUser: '   ' }),
      ],
      options,
    );

    expect(inventory._meta.hostvars['host-a'].ansible_user).toBe('root');
    expect(inventory._meta.hostvars['host-b'].ansible_user).toBe('ansible');
    expect(inventory._meta.hostvars['host-c'].ansible_user).toBe('ansible');
  });

  it('groups by capability and leaves capability-less hosts ungrouped', () => {
    const inventory = buildAnsibleInventory(
      [
        host({ name: 'host-a', capabilities: { docker: true } }),
        host({ name: 'host-b', capabilities: { docker: true, zfs: true } }),
        host({ name: 'host-c', capabilities: {} }),
      ],
      options,
    );

    expect(inventory.all.children).toEqual(['docker', 'zfs', 'ungrouped']);
    expect(inventory.docker).toEqual({ hosts: ['host-a', 'host-b'] });
    expect(inventory.zfs).toEqual({ hosts: ['host-b'] });
    expect(inventory.ungrouped).toEqual({ hosts: ['host-c'] });
  });

  it('omits a group with no members', () => {
    const inventory = buildAnsibleInventory(
      [host({ name: 'host-a', capabilities: { zfs: true } })],
      options,
    );

    expect(inventory.all.children).toEqual(['zfs', 'ungrouped']);
    expect(inventory.docker).toBeUndefined();
  });

  it('marks the host running the app so plays can skip it', () => {
    const inventory = buildAnsibleInventory(
      [host({ name: 'host-a' }), host({ name: 'host-b' })],
      { ...options, selfHostName: 'host-a' },
    );

    expect(inventory._meta.hostvars['host-a'].hlm_self_managed).toBe(true);
    expect(inventory._meta.hostvars['host-b'].hlm_self_managed).toBe(false);
  });
});

import type { ManagedHost } from '@/lib/database/repositories/host-repository';

export interface AnsibleInventoryGroup {
  hosts: string[];
}

export interface AnsibleInventory {
  _meta: { hostvars: Record<string, Record<string, unknown>> };
  all: { children: string[] };
  [group: string]: unknown;
}

export interface InventoryOptions {
  /** Name of the managed host this deployment runs on, if any. Excluded from plays that would recreate it. */
  selfHostName?: string | null;
  /** Fallback SSH login, used only for hosts with no `ssh_user` of their own. */
  remoteUser: string;
  appdataRoot: string;
}

/** Resolution order: the host's own `ssh_host`, then the agent URL hostname, then the host name. */
function ansibleHostFor(host: ManagedHost): string {
  const explicit = host.sshHost?.trim();
  if (explicit) return explicit;
  try {
    return new URL(host.agentUrl).hostname || host.name;
  } catch {
    return host.name;
  }
}

function ansibleUserFor(host: ManagedHost, fallback: string): string {
  return host.sshUser?.trim() || fallback;
}

/**
 * Ansible's script inventory plugin reads `_meta.hostvars` in a single `--list` call,
 * so it is always populated and `--host` never has to be invoked.
 */
export function buildAnsibleInventory(
  hosts: ManagedHost[],
  options: InventoryOptions,
): AnsibleInventory {
  const hostvars: Record<string, Record<string, unknown>> = {};
  const groups: Record<string, string[]> = { docker: [], zfs: [] };
  const names: string[] = [];

  for (const host of [...hosts].sort((a, b) => a.name.localeCompare(b.name))) {
    names.push(host.name);
    hostvars[host.name] = {
      ansible_host: ansibleHostFor(host),
      ansible_user: ansibleUserFor(host, options.remoteUser),
      hlm_appdata_root: options.appdataRoot,
      hlm_host_status: host.status,
      hlm_self_managed: host.name === options.selfHostName,
    };
    if (host.capabilities.docker) groups.docker.push(host.name);
    if (host.capabilities.zfs) groups.zfs.push(host.name);
  }

  const children = Object.entries(groups)
    .filter(([, members]) => members.length > 0)
    .map(([group]) => group);

  const inventory: AnsibleInventory = {
    _meta: { hostvars },
    all: { children: [...children, 'ungrouped'] },
    ungrouped: { hosts: names.filter((name) => !children.some((g) => groups[g].includes(name))) },
  };

  for (const group of children) {
    inventory[group] = { hosts: groups[group] };
  }

  return inventory;
}

import type {
  HostListItem,
  AddHostResult,
  HealthCheckResult,
  UpdateAgentResult,
  SetAgentAutoUpdateResult,
} from '@/data/hosts/functions';

/**
 * Build a plausible managed host from partial enrollment input. Pass `id` to
 * reuse an existing host id (e.g. on update) instead of consuming a new one.
 */
function buildHost(
  data: {
    name: string;
    agentUrl: string;
    capabilities?: { docker?: boolean; zfs?: boolean };
  },
  id: number = nextMockId++,
): HostListItem {
  const now = new Date().toISOString();
  return {
    id,
    name: data.name,
    agentUrl: data.agentUrl,
    capabilities: data.capabilities ?? {},
    agentVersion: '0.1.0',
    agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
    agentImageTag: 'latest',
    autoUpdate: false,
    status: 'healthy',
    createdAt: now,
    updatedAt: now,
  };
}

const mockHosts: readonly HostListItem[] = [
  {
    id: 1,
    name: 'homeserver',
    agentUrl: 'http://192.168.1.10:9090',
    capabilities: { docker: true },
    agentVersion: '0.1.0',
    agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
    agentImageTag: 'latest',
    autoUpdate: false,
    status: 'healthy',
    createdAt: '2026-01-15T10:00:00Z',
    updatedAt: '2026-01-15T10:00:00Z',
  },
  {
    id: 2,
    name: 'media-server',
    agentUrl: 'http://192.168.1.20:9090',
    capabilities: { docker: true, zfs: true },
    agentVersion: '0.1.0',
    agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
    agentImageTag: 'latest',
    autoUpdate: true,
    status: 'healthy',
    createdAt: '2026-02-01T14:30:00Z',
    updatedAt: '2026-02-01T14:30:00Z',
  },
];

let nextMockId = mockHosts.length + 1;

/** Intentionally stateless: returns a plausible result without mutating mockHosts. Demo mode shows a fixed set of hosts. */
export async function verifyHost(data: {
  name: string;
  agentUrl: string;
  agentToken: string;
  capabilities?: { docker?: boolean; zfs?: boolean };
}): Promise<AddHostResult> {
  return { host: buildHost(data) };
}

export async function updateHost(data: {
  hostId: number;
  name: string;
  agentUrl: string;
  capabilities?: { docker?: boolean; zfs?: boolean };
}): Promise<HostListItem> {
  return buildHost(data, data.hostId);
}

/** Intentionally stateless: returns success without mutating mockHosts. */
export async function removeHost(_data: {
  hostId: number;
}): Promise<{ success: boolean }> {
  return { success: true };
}

export async function listHosts(): Promise<HostListItem[]> {
  return [...mockHosts];
}

export async function checkHostHealth(_data: {
  hostId: number;
}): Promise<HealthCheckResult> {
  return {
    hostId: _data.hostId,
    healthy: true,
    version: '0.1.0',
    dockerVersion: '24.0.7',
    agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
    agentImageTag: 'latest',
  };
}

export async function updateAgent(data: {
  hostId: number;
}): Promise<UpdateAgentResult> {
  return {
    hostId: data.hostId,
    healthy: true,
    version: '0.1.0',
    dockerVersion: '24.0.7',
    agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:latest',
    agentImageTag: 'latest',
  };
}

export async function setAgentAutoUpdate(data: {
  hostId: number;
  autoUpdate: boolean;
}): Promise<SetAgentAutoUpdateResult> {
  return {
    host: buildHost({ name: 'homeserver', agentUrl: 'http://192.168.1.10:9090' }, data.hostId),
    propagation: { applied: true },
  };
}

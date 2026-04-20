import type {
  HostListItem,
  AddHostResult,
  HealthCheckResult,
  UpdateAgentResult,
} from '@/data/hosts/functions';

const mockHosts: readonly HostListItem[] = [
  {
    id: 1,
    name: 'homeserver',
    agentUrl: 'http://192.168.1.10:9090',
    capabilities: { docker: true },
    agentVersion: '0.1.0',
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
    status: 'healthy',
    createdAt: '2026-02-01T14:30:00Z',
    updatedAt: '2026-02-01T14:30:00Z',
  },
];

let nextMockId = mockHosts.length + 1;

/** Intentionally stateless: returns a plausible result without mutating mockHosts. Demo mode shows a fixed set of hosts. */
export async function verifyHost(_data: {
  name: string;
  agentUrl: string;
  agentToken: string;
  capabilities?: { docker?: boolean; zfs?: boolean };
}): Promise<AddHostResult> {
  const now = new Date().toISOString();
  const newHost: HostListItem = {
    id: nextMockId++,
    name: _data.name,
    agentUrl: _data.agentUrl,
    capabilities: _data.capabilities ?? {},
    agentVersion: '0.1.0',
    status: 'healthy',
    createdAt: now,
    updatedAt: now,
  };
  return { host: newHost };
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

export async function updateAgent(_data: {
  hostId: number;
}): Promise<UpdateAgentResult> {
  return {
    hostId: _data.hostId,
    healthy: true,
    version: '0.2.0',
  };
}

export async function checkHostHealth(_data: {
  hostId: number;
}): Promise<HealthCheckResult> {
  return {
    hostId: _data.hostId,
    healthy: true,
    version: '0.1.0',
    dockerVersion: '24.0.7',
  };
}

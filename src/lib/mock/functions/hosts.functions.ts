import type {
  HostListItem,
  AddHostResult,
  HealthCheckResult,
  UpdateAgentResult,
} from '@/data/hosts.functions';

const mockHosts: HostListItem[] = [
  {
    id: 1,
    name: 'homeserver',
    agentUrl: 'http://192.168.1.10:9090',
    socketProxyUrl: 'tcp://192.168.1.10:2375',
    agentVersion: '0.1.0',
    status: 'online',
    createdAt: '2026-01-15T10:00:00Z',
    updatedAt: '2026-01-15T10:00:00Z',
  },
  {
    id: 2,
    name: 'media-server',
    agentUrl: 'http://192.168.1.20:9090',
    socketProxyUrl: 'tcp://192.168.1.20:2375',
    agentVersion: '0.1.0',
    status: 'online',
    createdAt: '2026-02-01T14:30:00Z',
    updatedAt: '2026-02-01T14:30:00Z',
  },
];

export async function addHost(_data: {
  name: string;
  socketProxyUrl: string;
  agentPort?: number;
}): Promise<AddHostResult> {
  const now = new Date().toISOString();
  const newHost: HostListItem = {
    id: mockHosts.length + 1,
    name: _data.name,
    agentUrl: `http://mock-host:${_data.agentPort ?? 9090}`,
    socketProxyUrl: _data.socketProxyUrl,
    agentVersion: '0.1.0',
    status: 'online',
    createdAt: now,
    updatedAt: now,
  };
  return { host: newHost, healthy: true };
}

export async function removeHost(_data: {
  hostId: number;
}): Promise<{ success: boolean }> {
  return { success: true };
}

export async function listHosts(): Promise<HostListItem[]> {
  return mockHosts;
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

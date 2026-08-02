import { describe, it, expect, mock } from 'bun:test';
import { handleInventoryRequest } from '@/lib/ansible/inventory-handler';
import { AnsibleDisabledError, type AnsibleConfig } from '@/lib/config/ansible-config';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';

const config: AnsibleConfig = {
  enabled: true,
  sidecarUrl: 'http://sidecar:9095',
  sidecarToken: 'token-value',
  remoteUser: 'ansible',
  appdataRoot: '/srv/appdata',
  selfHostName: null,
};

const hosts: ManagedHost[] = [
  {
    id: 1,
    name: 'host-a',
    agentUrl: 'https://host-a.example:9090',
    capabilities: { docker: true },
    agentVersion: null,
    status: 'healthy',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
];

function request(token?: string): Request {
  return new Request('http://app/api/ansible-inventory', {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

describe('handleInventoryRequest', () => {
  it('returns 503 when the feature flag is off', async () => {
    const listHosts = mock(async () => hosts);
    const response = await handleInventoryRequest(request('token-value'), {
      loadConfig: () => {
        throw new AnsibleDisabledError();
      },
      listHosts,
    });

    expect(response.status).toBe(503);
    expect(listHosts).not.toHaveBeenCalled();
  });

  it('rejects a missing, malformed, or wrong bearer token', async () => {
    const listHosts = mock(async () => hosts);
    const deps = { loadConfig: () => config, listHosts };

    for (const req of [request(), request(''), request('wrong-token'), new Request('http://app/x', { headers: { authorization: 'token-value' } })]) {
      const response = await handleInventoryRequest(req, deps);
      expect(response.status).toBe(401);
    }
    expect(listHosts).not.toHaveBeenCalled();
  });

  it('serves the inventory to a matching token', async () => {
    const response = await handleInventoryRequest(request('token-value'), {
      loadConfig: () => config,
      listHosts: async () => hosts,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { docker: { hosts: string[] } };
    expect(body.docker.hosts).toEqual(['host-a']);
  });
});

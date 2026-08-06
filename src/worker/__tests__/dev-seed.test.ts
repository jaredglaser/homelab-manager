import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import type { DatabaseClient } from '@/lib/clients/database-client';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';

const mockHostFindAll = mock((): Promise<ManagedHost[]> => Promise.resolve([]));
const mockHostCreate = mock(() =>
  Promise.resolve({ id: 1, name: 'localhost', agentUrl: 'http://localhost:9090', status: 'pending' as const }),
);
const mockHostUpdate = mock(() =>
  Promise.resolve({ id: 1, name: 'localhost', agentUrl: 'http://localhost:9090', status: 'pending' as const }),
);
const mockHostUpdateStatus = mock(() => Promise.resolve());

mock.module('@/lib/database/repositories/host-repository', () => ({
  HostRepository: class {
    findAll = mockHostFindAll;
    create = mockHostCreate;
    update = mockHostUpdate;
    updateStatus = mockHostUpdateStatus;
  },
}));

const mockKeypairCreateForHost = mock(() =>
  Promise.resolve({ hostName: 'localhost', publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' }, privateKey: {} }),
);
const mockKeypairGetPublicJwk = mock<() => Promise<{ kty: string; crv: string; x: string } | null>>(
  () => Promise.resolve(null),
);

mock.module('@/lib/database/repositories/agent-keypairs-repository', () => ({
  AgentKeypairsRepository: class {
    createForHost = mockKeypairCreateForHost;
    getPublicJwkForHost = mockKeypairGetPublicJwk;
  },
}));

mock.module('@/lib/crypto/master-key', () => ({
  loadMasterKeyring: mock(async () => ({ activeKid: 'v1', keys: new Map() })),
}));

const mockExistsSync = mock(() => true);
const mockWriteFileSync = mock((_p: string, _d: string) => {});
const mockMkdirSync = mock((_p: string, _opts?: unknown) => undefined);

mock.module('node:fs', () => ({
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
  readFileSync: mock(() => ''),
}));

function makeMockDb(): DatabaseClient {
  return { getPool: () => ({}) } as unknown as DatabaseClient;
}

function mockHost(overrides: Partial<ManagedHost> & Pick<ManagedHost, 'id' | 'name' | 'agentUrl' | 'status'>): ManagedHost {
  return {
    capabilities: { docker: true, zfs: false },
    agentVersion: null,
    agentImage: null,
    agentImageTag: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe('seedDevAgent', () => {
  let consoleInfoSpy: ReturnType<typeof spyOn>;
  let setTimeoutSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockHostFindAll.mockClear();
    mockHostCreate.mockClear();
    mockHostUpdate.mockClear();
    mockHostUpdateStatus.mockClear();
    mockKeypairCreateForHost.mockClear();
    mockKeypairGetPublicJwk.mockClear();
    mockExistsSync.mockClear();
    mockWriteFileSync.mockClear();
    mockMkdirSync.mockClear();
    mockExistsSync.mockImplementation(() => true);
    mockKeypairGetPublicJwk.mockImplementation(() => Promise.resolve(null));
    mockHostFindAll.mockImplementation(() => Promise.resolve([]));

    consoleInfoSpy = spyOn(console, 'info').mockImplementation(() => {});
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((cb: TimerHandler) => { if (typeof cb === 'function') cb(); return 0; }) as unknown as typeof setTimeout,
    );
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    process.env.HOMELAB_DEV_SEED = 'true';
    process.env.MASTER_KEY = Buffer.alloc(32).toString('base64');
    delete process.env.DEV_HOST_NAME;
    delete process.env.DEV_AGENT_PUBKEY_FILE;
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
    setTimeoutSpy.mockRestore();
    fetchSpy.mockRestore();
    process.env = { ...originalEnv };
  });

  it('returns early when HOMELAB_DEV_SEED is not true', async () => {
    process.env.HOMELAB_DEV_SEED = 'false';
    const { seedDevAgent } = await import('../dev-seed');
    await seedDevAgent(makeMockDb());
    expect(mockHostFindAll).not.toHaveBeenCalled();
  });

  it('creates host and keypair on first run and marks healthy after successful health check', async () => {
    const { seedDevAgent } = await import('../dev-seed');
    await seedDevAgent(makeMockDb());

    expect(mockHostCreate).toHaveBeenCalledTimes(1);
    expect(mockKeypairCreateForHost).toHaveBeenCalledTimes(1);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockHostUpdateStatus).toHaveBeenCalledWith(1, 'healthy');
  });

  it('updates agent URL when existing host has a stale URL', async () => {
    mockHostFindAll.mockImplementation(() =>
      Promise.resolve([mockHost({ id: 2, name: 'localhost', agentUrl: 'http://old-host:9090', status: 'healthy' })]),
    );
    mockKeypairGetPublicJwk.mockImplementation(() =>
      Promise.resolve({ kty: 'OKP', crv: 'Ed25519', x: 'abc' }),
    );

    const { seedDevAgent } = await import('../dev-seed');
    await seedDevAgent(makeMockDb());

    expect(mockHostUpdate).toHaveBeenCalledWith(2, { agentUrl: 'http://localhost:9090' });
    expect(mockHostCreate).not.toHaveBeenCalled();
  });

  it('skips host create when existing host already has the correct URL', async () => {
    mockHostFindAll.mockImplementation(() =>
      Promise.resolve([mockHost({ id: 3, name: 'localhost', agentUrl: 'http://localhost:9090', status: 'healthy' })]),
    );
    mockKeypairGetPublicJwk.mockImplementation(() =>
      Promise.resolve({ kty: 'OKP', crv: 'Ed25519', x: 'abc' }),
    );

    const { seedDevAgent } = await import('../dev-seed');
    await seedDevAgent(makeMockDb());

    expect(mockHostCreate).not.toHaveBeenCalled();
    expect(mockHostUpdate).not.toHaveBeenCalled();
  });

  it('re-writes pubkey file when keypair exists but file is missing', async () => {
    const existingJwk = { kty: 'OKP', crv: 'Ed25519', x: 'existing-key' };
    mockHostFindAll.mockImplementation(() =>
      Promise.resolve([mockHost({ id: 1, name: 'localhost', agentUrl: 'http://localhost:9090', status: 'pending' })]),
    );
    mockKeypairGetPublicJwk.mockImplementation(() => Promise.resolve(existingJwk));
    mockExistsSync.mockImplementation(() => false);

    const { seedDevAgent } = await import('../dev-seed');
    await seedDevAgent(makeMockDb());

    expect(mockKeypairCreateForHost).not.toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const written = mockWriteFileSync.mock.calls[0][1] as string;
    expect(JSON.parse(written)).toEqual(existingJwk);
  });

  it('leaves host as pending when all health check attempts are exhausted', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 503 }));

    const { seedDevAgent } = await import('../dev-seed');
    await seedDevAgent(makeMockDb());

    const statusCalls = mockHostUpdateStatus.mock.calls as unknown as Array<[number, string]>;
    expect(statusCalls.some(([, s]) => s === 'healthy')).toBe(false);
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('health check failed'));
  });

  it('treats fetch network errors during health check as unhealthy attempts', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const { seedDevAgent } = await import('../dev-seed');
    await seedDevAgent(makeMockDb());

    const statusCalls = mockHostUpdateStatus.mock.calls as unknown as Array<[number, string]>;
    expect(statusCalls.some(([, s]) => s === 'healthy')).toBe(false);
  });
});

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpToolContext } from '@/lib/mcp/context';

const MAX_RESULT_BYTES = 256_000;

class MockMcpToolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function mockParseEntityId(entityId: string): { host: string; containerId: string } {
  const idx = entityId.indexOf('/');
  return { host: entityId.slice(0, idx), containerId: entityId.slice(idx + 1) };
}

function mockHasScope(scopes: string[], required: string): boolean {
  return scopes.includes(required) || scopes.includes('mcp:read');
}

function mockIso(value: Date | number): string {
  return new Date(value).toISOString();
}

function mockTruncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function mockEncodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...payload })).toString('base64url');
}

function mockDecodeCursor<T>(raw: string): T {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as T;
  } catch {
    throw new MockMcpToolError('invalid_cursor', `Malformed cursor: ${raw}`);
  }
}

function mockOk<T>(structured: T) {
  const json = JSON.stringify(structured);
  if (Buffer.byteLength(json, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error(`Result exceeds ${MAX_RESULT_BYTES} bytes`);
  }
  return { content: [{ type: 'text' as const, text: json }], structuredContent: structured };
}

function mockFail(err: MockMcpToolError) {
  return { isError: true, content: [{ type: 'text' as const, text: `${err.code}: ${err.message}` }] };
}

mock.module('@/lib/mcp/shared', () => ({
  zEntityId: (() => {
    const { z } = require('zod');
    return z.string().regex(/^[^/\s]+\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, { message: 'Expected an entity id' });
  })(),
  parseEntityId: mockParseEntityId,
  hasScope: mockHasScope,
  iso: mockIso,
  truncateText: mockTruncateText,
  encodeCursor: mockEncodeCursor,
  decodeCursor: mockDecodeCursor,
  McpToolError: MockMcpToolError,
  ok: mockOk,
  fail: mockFail,
}));

const listContainerSnapshotMock = mock(async (_pool: unknown, _filter: unknown): Promise<unknown[]> => []);
const getContainerSnapshotMock = mock(async (_pool: unknown, _host: string, _containerId: string): Promise<unknown> => null);
const getContainerCountsByHostMock = mock(async (_pool: unknown): Promise<Map<string, number>> => new Map());

mock.module('@/lib/mcp/queries', () => ({
  listContainerSnapshot: listContainerSnapshotMock,
  getContainerSnapshot: getContainerSnapshotMock,
  getContainerCountsByHost: getContainerCountsByHostMock,
}));

const findAllMock = mock(async (): Promise<unknown[]> => []);
const findByNameMock = mock(async (_name: string): Promise<unknown> => null);

mock.module('@/lib/database/repositories/host-repository', () => ({
  HostRepository: mock().mockImplementation(() => ({ findAll: findAllMock, findByName: findByNameMock })),
}));

const { registerHostTools } = await import('@/lib/mcp/tools/hosts');

function makeManagedHost(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    name: 'nuc1',
    agentUrl: 'https://nuc1.local:8443',
    capabilities: { docker: true, zfs: false },
    agentVersion: '0.14.2',
    agentImage: 'ghcr.io/example/agent',
    agentImageTag: 'latest',
    status: 'healthy',
    createdAt: new Date('2026-03-02T11:04:00.000Z'),
    updatedAt: new Date('2026-03-02T11:04:00.000Z'),
    ...overrides,
  };
}

function makeSnapshotRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    at: new Date('2026-08-14T22:10:04.221Z'),
    host: 'nuc1',
    containerId: '9f2c1ab34de5',
    eventType: 'upsert',
    state: 'running',
    name: 'plex',
    image: 'lscr.io/linuxserver/plex:1.41.0',
    labels: { 'com.docker.compose.project': 'media' },
    ports: [{ containerPort: 32400, protocol: 'tcp', hostIp: null, hostPort: 32400 }],
    mounts: [{ type: 'bind', source: '/srv/media', destination: '/data', rw: true }],
    composeProject: 'media',
    serviceKey: 'plex',
    startedAt: new Date('2026-08-14T22:10:03.000Z'),
    finishedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function makeCtx(scopes: string[] = ['mcp:hosts:read']): McpToolContext {
  return {
    pool: {} as McpToolContext['pool'],
    scopes,
    callAgent: mock(async () => new Response('ok')),
  };
}

async function connectedClient(ctx: McpToolContext) {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  registerHostTools(server, ctx);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

beforeEach(() => {
  listContainerSnapshotMock.mockClear();
  listContainerSnapshotMock.mockImplementation(async () => []);
  getContainerSnapshotMock.mockClear();
  getContainerSnapshotMock.mockImplementation(async () => null);
  getContainerCountsByHostMock.mockClear();
  getContainerCountsByHostMock.mockImplementation(async () => new Map());
  findAllMock.mockClear();
  findAllMock.mockImplementation(async () => []);
  findByNameMock.mockClear();
  findByNameMock.mockImplementation(async () => null);
});

afterEach(() => {
  mock.restore();
});

describe('registerHostTools', () => {
  it('registers no tools when the context lacks mcp:hosts:read and mcp:read', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:logs:read']));
    expect(client.getServerCapabilities()?.tools).toBeUndefined();
  });

  it('registers all three tools when mcp:hosts:read is present', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:hosts:read']));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_container', 'list_containers', 'list_hosts']);
  });

  it('registers all three tools when the umbrella mcp:read scope is present', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:read']));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(3);
  });
});

describe('list_hosts', () => {
  it('returns hosts with grouped container counts, filtered by capability', async () => {
    findAllMock.mockImplementation(async () => [
      makeManagedHost({ name: 'nuc1', capabilities: { docker: true, zfs: false } }),
      makeManagedHost({ name: 'nas1', capabilities: { docker: false, zfs: true } }),
    ]);
    getContainerCountsByHostMock.mockImplementation(async () => new Map([['nuc1', 2], ['nas1', 1]]));

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_hosts', arguments: { capability: 'docker' } });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      hosts: [
        {
          name: 'nuc1',
          status: 'healthy',
          capabilities: { docker: true, zfs: false },
          agentVersion: '0.14.2',
          agentImageTag: 'latest',
          containerCount: 2,
          addedAt: '2026-03-02T11:04:00.000Z',
        },
      ],
      count: 1,
      truncated: false,
    });
  });

  it('returns every host when no capability filter is given', async () => {
    findAllMock.mockImplementation(async () => [
      makeManagedHost({ name: 'nuc1' }),
      makeManagedHost({ name: 'nas1', capabilities: { docker: false, zfs: true } }),
    ]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_hosts', arguments: {} });

    expect(result.structuredContent).toMatchObject({ count: 2, truncated: false });
  });

  it('caps at 200 hosts and reports truncated', async () => {
    findAllMock.mockImplementation(async () =>
      Array.from({ length: 205 }, (_, i) => makeManagedHost({ name: `host${i}` })),
    );

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_hosts', arguments: {} });

    const structured = result.structuredContent as { hosts: unknown[]; count: number; truncated: boolean };
    expect(structured.hosts).toHaveLength(200);
    expect(structured.count).toBe(200);
    expect(structured.truncated).toBe(true);
  });

  it('rejects an invalid capability value', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_hosts', arguments: { capability: 'nfs' } });

    expect(result.isError).toBe(true);
  });

  it('surfaces a downstream query failure as an error result', async () => {
    findAllMock.mockImplementation(async () => [makeManagedHost()]);
    getContainerCountsByHostMock.mockImplementation(async () => {
      throw new Error('connection refused');
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_hosts', arguments: {} });

    expect(result.isError).toBe(true);
  });
});

describe('list_containers', () => {
  it('returns mapped containers with no next page', async () => {
    listContainerSnapshotMock.mockImplementation(async () => [
      makeSnapshotRow({ containerId: '9f2c1ab34de5', finishedAt: null }),
      makeSnapshotRow({
        containerId: 'shortid',
        name: 'tautulli',
        composeProject: 'media',
        serviceKey: 'tautulli',
        startedAt: null,
        finishedAt: new Date('2026-08-14T23:00:00.000Z'),
        exitCode: 0,
      }),
    ]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_containers', arguments: { limit: 50 } });

    expect(listContainerSnapshotMock).toHaveBeenCalledWith(expect.anything(), {
      host: undefined,
      state: undefined,
      stack: undefined,
      nameContains: undefined,
      afterEntityId: undefined,
      limit: 51,
    });

    const structured = result.structuredContent as { containers: Array<Record<string, unknown>>; hasMore: boolean; nextCursor: unknown; count: number };
    expect(structured.count).toBe(2);
    expect(structured.hasMore).toBe(false);
    expect(structured.nextCursor).toBeNull();
    expect(structured.containers[0]).toEqual({
      entityId: 'nuc1/9f2c1ab34de5',
      host: 'nuc1',
      containerId: '9f2c1ab34de5',
      name: 'plex',
      image: 'lscr.io/linuxserver/plex:1.41.0',
      state: 'running',
      stack: 'media',
      service: 'plex',
      startedAt: '2026-08-14T22:10:03.000Z',
      finishedAt: null,
      exitCode: null,
      lastEventAt: '2026-08-14T22:10:04.221Z',
    });
    expect(structured.containers[1]).toMatchObject({
      entityId: 'nuc1/shortid',
      containerId: 'shortid',
      startedAt: null,
      finishedAt: '2026-08-14T23:00:00.000Z',
      exitCode: 0,
    });
  });

  it('sets hasMore and a decodable nextCursor when more rows exist than the limit', async () => {
    listContainerSnapshotMock.mockImplementation(async () => [
      makeSnapshotRow({ containerId: 'aaaaaaaaaaaa' }),
      makeSnapshotRow({ containerId: 'bbbbbbbbbbbb' }),
    ]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_containers', arguments: { limit: 1 } });

    const structured = result.structuredContent as { hasMore: boolean; nextCursor: string; containers: unknown[] };
    expect(structured.hasMore).toBe(true);
    expect(structured.containers).toHaveLength(1);
    expect(structured.nextCursor).not.toBeNull();

    const decoded = JSON.parse(Buffer.from(structured.nextCursor, 'base64url').toString('utf8'));
    expect(decoded).toEqual({ v: 1, after: 'nuc1/aaaaaaaaaaaa' });
  });

  it('passes a decoded cursor through as afterEntityId', async () => {
    listContainerSnapshotMock.mockImplementation(async () => []);
    const cursor = Buffer.from(JSON.stringify({ v: 1, after: 'nuc1/deadbeefcafe' })).toString('base64url');

    const { client } = await connectedClient(makeCtx());
    await client.callTool({ name: 'list_containers', arguments: { cursor } });

    expect(listContainerSnapshotMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ afterEntityId: 'nuc1/deadbeefcafe' }),
    );
  });

  it('rejects a limit above the cap', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_containers', arguments: { limit: 500 } });

    expect(result.isError).toBe(true);
  });

  it('returns invalid_cursor as a tool error for a malformed cursor', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_containers', arguments: { cursor: 'not valid base64 json!!' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('invalid_cursor');
  });

  it('surfaces a downstream query failure as an error result', async () => {
    listContainerSnapshotMock.mockImplementation(async () => {
      throw new Error('connection refused');
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_containers', arguments: {} });

    expect(result.isError).toBe(true);
  });
});

describe('get_container', () => {
  it('returns full detail with capped ports, mounts, and labels', async () => {
    findByNameMock.mockImplementation(async () => makeManagedHost());

    const manyLabels: Record<string, string> = { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'plex' };
    for (let i = 0; i < 25; i++) {
      manyLabels[`custom.label.z${String(i).padStart(2, '0')}`] = i === 0 ? 'x'.repeat(250) : `value-${i}`;
    }
    const manyPorts = Array.from({ length: 25 }, (_, i) => ({
      containerPort: 1000 + i,
      protocol: 'tcp',
      hostIp: null,
      hostPort: 1000 + i,
    }));
    const manyMounts = Array.from({ length: 25 }, (_, i) => ({
      type: 'bind',
      source: `/src/${i}`,
      destination: `/dst/${i}`,
      rw: i % 2 === 0,
    }));

    getContainerSnapshotMock.mockImplementation(async () =>
      makeSnapshotRow({ labels: manyLabels, ports: manyPorts, mounts: manyMounts }),
    );

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_container', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      entityId: string;
      host: Record<string, unknown>;
      container: Record<string, unknown>;
    };

    expect(structured.entityId).toBe('nuc1/9f2c1ab34de5');
    expect(structured.host).toEqual({ name: 'nuc1', status: 'healthy', agentVersion: '0.14.2' });

    const container = structured.container as {
      ports: unknown[];
      portCount: number;
      mounts: unknown[];
      mountCount: number;
      labels: Record<string, string>;
      labelCount: number;
    };
    expect(container.ports).toHaveLength(20);
    expect(container.portCount).toBe(25);
    expect(container.ports[0]).toEqual({ privatePort: 1000, publicPort: 1000, type: 'tcp' });
    expect(container.mounts).toHaveLength(20);
    expect(container.mountCount).toBe(25);
    expect(container.mounts[0]).toEqual({ source: '/src/0', destination: '/dst/0', mode: 'rw' });
    expect(container.mounts[1]).toEqual({ source: '/src/1', destination: '/dst/1', mode: 'ro' });

    expect(container.labelCount).toBe(27);
    expect(container.labels['com.docker.compose.project']).toBe('media');
    expect(container.labels['com.docker.compose.service']).toBe('plex');
    expect(container.labels['custom.label.z00']).toHaveLength(200);
    const otherKeys = Object.keys(container.labels).filter((k) => k.startsWith('custom.'));
    expect(otherKeys).toHaveLength(20);
    expect(otherKeys).toContain('custom.label.z00');
    expect(otherKeys).toContain('custom.label.z19');
    expect(otherKeys).not.toContain('custom.label.z24');
  });

  it('omits labels but keeps labelCount when includeLabels is false', async () => {
    findByNameMock.mockImplementation(async () => makeManagedHost());
    getContainerSnapshotMock.mockImplementation(async () =>
      makeSnapshotRow({ labels: { a: '1', b: '2' } }),
    );

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'get_container',
      arguments: { entityId: 'nuc1/9f2c1ab34de5', includeLabels: false },
    });

    const container = (result.structuredContent as { container: { labels: Record<string, string>; labelCount: number } }).container;
    expect(container.labels).toEqual({});
    expect(container.labelCount).toBe(2);
  });

  it('rejects a malformed entity id', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_container', arguments: { entityId: 'no-slash-here' } });

    expect(result.isError).toBe(true);
  });

  it('returns unknown_host when the host is not managed', async () => {
    findByNameMock.mockImplementation(async () => null);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_container', arguments: { entityId: 'ghost/abc123456789' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_host');
  });

  it('returns unknown_container when the snapshot has no row', async () => {
    findByNameMock.mockImplementation(async () => makeManagedHost());
    getContainerSnapshotMock.mockImplementation(async () => null);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_container', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_container');
  });

  it('returns unknown_container with the destroy time when the latest event is destroy', async () => {
    findByNameMock.mockImplementation(async () => makeManagedHost());
    getContainerSnapshotMock.mockImplementation(async () => ({
      at: new Date('2026-08-15T01:00:00.000Z'),
      host: 'nuc1',
      containerId: '9f2c1ab34de5',
      eventType: 'destroy',
    }));

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_container', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_container');
    expect(text).toContain('2026-08-15T01:00:00.000Z');
  });

  it('surfaces a downstream query failure as an error result', async () => {
    findByNameMock.mockImplementation(async () => makeManagedHost());
    getContainerSnapshotMock.mockImplementation(async () => {
      throw new Error('connection refused');
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_container', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBe(true);
  });
});

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import yaml from 'js-yaml';
import { MANIFEST, composePath } from '@/lib/stacks/stack-repo-layout';
import type { McpToolContext } from '@/lib/mcp/context';

const MAX_RESULT_BYTES = 256_000;
const DEFAULT_WINDOW = {
  from: new Date('2026-08-15T11:00:00.000Z'),
  to: new Date('2026-08-15T12:00:00.000Z'),
  spanSeconds: 3600,
};

class MockMcpToolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class MockFileNotFoundError extends Error {
  constructor(path: string) {
    super(`File not found: ${path}`);
    this.name = 'FileNotFoundError';
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

const resolveWindowMock = mock(
  (_input: { since?: string; until?: string }, _opts: { defaultSinceSeconds: number; maxSpanSeconds: number }) =>
    DEFAULT_WINDOW,
);

mock.module('@/lib/mcp/shared', () => ({
  zEntityId: (() => {
    const { z } = require('zod');
    return z.string().regex(/^[^/\s]+\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, { message: 'Expected an entity id' });
  })(),
  zTime: (() => {
    const { z } = require('zod');
    const RELATIVE_TIME = /^(\d{1,6})([smhd])$/;
    return z
      .string()
      .refine((v: string) => RELATIVE_TIME.test(v) || !Number.isNaN(Date.parse(v)), {
        message: 'Expected an ISO 8601 timestamp or a relative duration',
      });
  })(),
  parseEntityId: mockParseEntityId,
  resolveWindow: resolveWindowMock,
  hasScope: mockHasScope,
  iso: mockIso,
  McpToolError: MockMcpToolError,
  ok: mockOk,
  fail: mockFail,
}));

const getContainerSnapshotMock = mock(async (_pool: unknown, _host: string, _containerId: string): Promise<unknown> => null);

mock.module('@/lib/mcp/queries', () => ({
  getContainerSnapshot: getContainerSnapshotMock,
}));

const getDockerStatsForContainerMock = mock(
  async (
    _containerIds: string[],
    _host: string | undefined,
    _from: Date,
    _to: Date,
    _targetPoints: number,
  ): Promise<unknown[]> => [],
);

const resolveStatsTierMock = mock((_table: string, _windowSeconds: number, _windowStartAgeSeconds: number) => ({
  relation: 'docker_stats',
  minBucketSeconds: 1,
}));

mock.module('@/lib/database/repositories/stats-repository', () => ({
  StatsRepository: mock().mockImplementation(() => ({ getDockerStatsForContainer: getDockerStatsForContainerMock })),
  resolveStatsTier: resolveStatsTierMock,
}));

const readFileFromRepoMock = mock(async (_repoPath: string, filePath: string, _ref: string): Promise<string> => {
  throw new MockFileNotFoundError(filePath);
});

mock.module('@/lib/git/repo', () => ({
  readFileFromRepo: readFileFromRepoMock,
  FileNotFoundError: MockFileNotFoundError,
}));

const loadGitConfigMock = mock(() => ({ reposDir: '/data/repos', repoName: 'stacks', repoPath: '/data/repos/stacks.git' }));

mock.module('@/lib/config/git-config', () => ({
  loadGitConfig: loadGitConfigMock,
}));

const { registerStatsTools } = await import('@/lib/mcp/tools/stats');

function makeManifestYaml(stacks: Record<string, { host: string; autoDeploy?: boolean }>): string {
  return yaml.dump({
    stacks: Object.fromEntries(
      Object.entries(stacks).map(([name, entry]) => [name, { host: entry.host, autoDeploy: entry.autoDeploy ?? false }]),
    ),
  });
}

function makeStatsRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    time: new Date('2026-08-15T11:00:00.000Z').getTime(),
    host: 'nuc1',
    container_id: '9f2c1ab34de5',
    container_name: 'plex',
    image: 'lscr.io/linuxserver/plex:1.41.0',
    cpu_percent: 10,
    memory_usage: 1_000_000_000,
    memory_limit: null,
    memory_percent: 10,
    network_rx_bytes_per_sec: 100,
    network_tx_bytes_per_sec: 10,
    block_io_read_bytes_per_sec: 0,
    block_io_write_bytes_per_sec: 0,
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
    composeProject: 'media',
    serviceKey: 'plex',
    startedAt: new Date('2026-08-14T22:10:03.000Z'),
    finishedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function makeCtx(scopes: string[] = ['mcp:stats:read', 'mcp:stacks:read']): McpToolContext {
  return {
    pool: {} as McpToolContext['pool'],
    scopes,
    callAgent: mock(async () => new Response('ok')),
  };
}

async function connectedClient(ctx: McpToolContext) {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  registerStatsTools(server, ctx);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

beforeEach(() => {
  resolveWindowMock.mockClear();
  resolveWindowMock.mockImplementation(() => DEFAULT_WINDOW);
  getContainerSnapshotMock.mockClear();
  getContainerSnapshotMock.mockImplementation(async () => null);
  getDockerStatsForContainerMock.mockClear();
  getDockerStatsForContainerMock.mockImplementation(async () => []);
  resolveStatsTierMock.mockClear();
  resolveStatsTierMock.mockImplementation(() => ({ relation: 'docker_stats', minBucketSeconds: 1 }));
  readFileFromRepoMock.mockClear();
  readFileFromRepoMock.mockImplementation(async (_repoPath: string, filePath: string) => {
    throw new MockFileNotFoundError(filePath);
  });
  loadGitConfigMock.mockClear();
  loadGitConfigMock.mockImplementation(() => ({ reposDir: '/data/repos', repoName: 'stacks', repoPath: '/data/repos/stacks.git' }));
});

afterEach(() => {
  mock.restore();
});

describe('registerStatsTools', () => {
  it('registers no tools when the context lacks both scopes and mcp:read', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:logs:read']));
    expect(client.getServerCapabilities()?.tools).toBeUndefined();
  });

  it('registers only get_stats when mcp:stats:read is present', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:stats:read']));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['get_stats']);
  });

  it('registers only get_stack_compose when mcp:stacks:read is present', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:stacks:read']));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['get_stack_compose']);
  });

  it('registers both tools when the umbrella mcp:read scope is present', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:read']));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_stack_compose', 'get_stats']);
  });
});

describe('get_stats', () => {
  it('summarizes multiple samples and returns downsampled points', async () => {
    getDockerStatsForContainerMock.mockImplementation(async () => [
      makeStatsRow({ time: new Date('2026-08-15T11:00:00.000Z').getTime(), cpu_percent: 10, memory_limit: null }),
      makeStatsRow({ time: new Date('2026-08-15T11:00:05.000Z').getTime(), cpu_percent: 20, memory_limit: 8_589_934_592 }),
      makeStatsRow({ time: new Date('2026-08-15T11:00:10.000Z').getTime(), cpu_percent: 30, memory_limit: null }),
      makeStatsRow({ time: new Date('2026-08-15T11:00:15.000Z').getTime(), cpu_percent: 40, memory_limit: null }),
    ]);
    resolveStatsTierMock.mockImplementation(() => ({ relation: 'docker_stats_1m', minBucketSeconds: 60 }));

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stats', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.entityId).toBe('nuc1/9f2c1ab34de5');
    expect(structured.tier).toBe('docker_stats_1m');
    expect(structured.sampleCount).toBe(4);
    expect(structured.resolutionSeconds).toBe(5);
    expect(structured.memoryLimitBytes).toBe(8_589_934_592);
    expect(structured.summaryBasis).toBe('bucketed');
    expect(structured.note).toBeUndefined();

    const summary = structured.summary as Record<string, { min: number; avg: number; max: number; p95: number; unit: string }>;
    expect(summary.cpuPercent).toEqual({ min: 10, avg: 25, max: 40, p95: 38.5, unit: 'percent_of_one_core' });
    expect(summary.memoryBytes.unit).toBe('bytes');
    expect(summary.memoryPercent.unit).toBe('percent_of_limit');
    expect(summary.netRxBytesPerSec.unit).toBe('bytes_per_second');
    expect(summary.netTxBytesPerSec.unit).toBe('bytes_per_second');
    expect(summary.blockReadBytesPerSec.unit).toBe('bytes_per_second');
    expect(summary.blockWriteBytesPerSec.unit).toBe('bytes_per_second');

    const points = structured.points as Array<Record<string, unknown>>;
    expect(points).toHaveLength(4);
    expect(points[0]).toEqual({
      at: '2026-08-15T11:00:00.000Z',
      cpuPercent: 10,
      memoryBytes: 1_000_000_000,
      memoryPercent: 10,
      netRxBytesPerSec: 100,
      netTxBytesPerSec: 10,
      blockReadBytesPerSec: 0,
      blockWriteBytesPerSec: 0,
    });

    expect(getDockerStatsForContainerMock).toHaveBeenCalledWith(
      ['9f2c1ab34de5'],
      'nuc1',
      DEFAULT_WINDOW.from,
      DEFAULT_WINDOW.to,
      60,
    );
    expect(resolveStatsTierMock).toHaveBeenCalledWith('docker_stats', 3600, expect.any(Number));
  });

  it('handles a single sample without dividing by a missing neighbor', async () => {
    getDockerStatsForContainerMock.mockImplementation(async () => [makeStatsRow({ cpu_percent: 42, memory_limit: null })]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stats', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.sampleCount).toBe(1);
    expect(structured.resolutionSeconds).toBe(0);
    expect(structured.memoryLimitBytes).toBeNull();

    const summary = structured.summary as Record<string, { min: number; avg: number; max: number; p95: number; unit: string }>;
    expect(summary.cpuPercent).toEqual({ min: 42, avg: 42, max: 42, p95: 42, unit: 'percent_of_one_core' });
  });

  it('omits points when includePoints is false, even with data present', async () => {
    getDockerStatsForContainerMock.mockImplementation(async () => [makeStatsRow()]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'get_stats',
      arguments: { entityId: 'nuc1/9f2c1ab34de5', includePoints: false },
    });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.points).toEqual([]);
    expect(structured.sampleCount).toBe(1);
  });

  it('returns a null-valued summary with a note when there are no rows in the window', async () => {
    getDockerStatsForContainerMock.mockImplementation(async () => []);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stats', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.sampleCount).toBe(0);
    expect(structured.resolutionSeconds).toBe(0);
    expect(structured.memoryLimitBytes).toBeNull();
    expect(structured.points).toEqual([]);
    expect(structured.note).toBe(
      'No stats rows in this window; the retention tier for this window may have dropped them.',
    );

    const summary = structured.summary as Record<string, { min: null; avg: null; max: null; p95: null; unit: string }>;
    expect(summary.cpuPercent).toEqual({ min: null, avg: null, max: null, p95: null, unit: 'percent_of_one_core' });
  });

  it('rejects a points value above the cap', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stats', arguments: { entityId: 'nuc1/9f2c1ab34de5', points: 301 } });

    expect(result.isError).toBe(true);
    expect(getDockerStatsForContainerMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed entity id', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stats', arguments: { entityId: 'no-slash-here' } });

    expect(result.isError).toBe(true);
  });

  it('surfaces a window_too_large error from resolveWindow as a tool error', async () => {
    resolveWindowMock.mockImplementation(() => {
      throw new MockMcpToolError('window_too_large', 'span exceeds 365 days');
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'get_stats',
      arguments: { entityId: 'nuc1/9f2c1ab34de5', since: '2000d' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('window_too_large');
  });

  it('surfaces a downstream query failure as an error result', async () => {
    getDockerStatsForContainerMock.mockImplementation(async () => {
      throw new Error('connection refused');
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stats', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBe(true);
  });
});

describe('get_stack_compose', () => {
  it('resolves a stack by name and lists its services', async () => {
    readFileFromRepoMock.mockImplementation(async (repoPath: string, filePath: string, ref: string) => {
      expect(repoPath).toBe('/data/repos/stacks.git');
      expect(ref).toBe('HEAD');
      if (filePath === MANIFEST) return makeManifestYaml({ media: { host: 'nuc1' } });
      if (filePath === composePath('media')) return 'services:\n  plex:\n    image: test\n  tautulli:\n    image: test2\n';
      throw new MockFileNotFoundError(filePath);
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stack_compose', arguments: { stack: 'media' } });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.stack).toBe('media');
    expect(structured.ref).toBe('HEAD');
    expect(structured.path).toBe('media/docker-compose.yml');
    expect(structured.truncated).toBe(false);
    expect(structured.services).toEqual(['plex', 'tautulli']);
    expect(structured.parseError).toBeUndefined();
    expect(structured.bytes).toBe(Buffer.byteLength(structured.content as string, 'utf8'));
  });

  it('resolves a stack from an entity id', async () => {
    getContainerSnapshotMock.mockImplementation(async () => makeSnapshotRow({ composeProject: 'media' }));
    readFileFromRepoMock.mockImplementation(async (_repoPath: string, filePath: string) => {
      if (filePath === MANIFEST) return makeManifestYaml({ media: { host: 'nuc1' } });
      if (filePath === composePath('media')) return 'services:\n  plex:\n    image: test\n';
      throw new MockFileNotFoundError(filePath);
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stack_compose', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.stack).toBe('media');
    expect(getContainerSnapshotMock).toHaveBeenCalledWith(expect.anything(), 'nuc1', '9f2c1ab34de5');
  });

  it('truncates content at the last complete line under maxBytes but still lists every service', async () => {
    const padding = Array.from({ length: 200 }, (_, i) => `    # padding line ${i}`).join('\n');
    const composeContent = `services:\n  plex:\n    image: test\n  tautulli:\n    image: test2\n${padding}\n`;

    readFileFromRepoMock.mockImplementation(async (_repoPath: string, filePath: string) => {
      if (filePath === MANIFEST) return makeManifestYaml({ media: { host: 'nuc1' } });
      if (filePath === composePath('media')) return composeContent;
      throw new MockFileNotFoundError(filePath);
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'get_stack_compose',
      arguments: { stack: 'media', maxBytes: 1024 },
    });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.truncated).toBe(true);
    expect(structured.bytes).toBeLessThanOrEqual(1024);
    expect((structured.content as string).endsWith('\n')).toBe(false);
    expect(composeContent.startsWith(structured.content as string)).toBe(true);
    expect(structured.services).toEqual(['plex', 'tautulli']);
  });

  it('returns a parse error instead of failing when the compose file is invalid YAML', async () => {
    readFileFromRepoMock.mockImplementation(async (_repoPath: string, filePath: string) => {
      if (filePath === MANIFEST) return makeManifestYaml({ media: { host: 'nuc1' } });
      if (filePath === composePath('media')) return "services: {plex: {image: 'test'\n";
      throw new MockFileNotFoundError(filePath);
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stack_compose', arguments: { stack: 'media' } });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.services).toEqual([]);
    expect(typeof structured.parseError).toBe('string');
  });

  it('returns an empty services list for valid YAML with no services key', async () => {
    readFileFromRepoMock.mockImplementation(async (_repoPath: string, filePath: string) => {
      if (filePath === MANIFEST) return makeManifestYaml({ media: { host: 'nuc1' } });
      if (filePath === composePath('media')) return "version: '3'\n";
      throw new MockFileNotFoundError(filePath);
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stack_compose', arguments: { stack: 'media' } });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.services).toEqual([]);
    expect(structured.parseError).toBeUndefined();
  });

  it('rejects when neither entityId nor stack is provided', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stack_compose', arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_stack');
  });

  it('rejects when both entityId and stack are provided', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'get_stack_compose',
      arguments: { entityId: 'nuc1/9f2c1ab34de5', stack: 'media' },
    });

    expect(result.isError).toBe(true);
  });

  it('rejects a ref shorter than the minimum length', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stack_compose', arguments: { stack: 'media', ref: 'ab' } });

    expect(result.isError).toBe(true);
  });

  it('reports unknown_stack when the entity is not part of a managed stack', async () => {
    getContainerSnapshotMock.mockImplementation(async () => makeSnapshotRow({ composeProject: null }));

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stack_compose', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_stack');
    expect(readFileFromRepoMock).not.toHaveBeenCalled();
  });

  it('reports unknown_stack when the manifest itself is missing at the given ref', async () => {
    readFileFromRepoMock.mockImplementation(async (_repoPath: string, filePath: string) => {
      throw new MockFileNotFoundError(filePath);
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stack_compose', arguments: { stack: 'media' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_stack');
  });

  it('reports unknown_stack when the stack is absent from the manifest', async () => {
    readFileFromRepoMock.mockImplementation(async (_repoPath: string, filePath: string) => {
      if (filePath === MANIFEST) return makeManifestYaml({ other: { host: 'nuc1' } });
      throw new MockFileNotFoundError(filePath);
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stack_compose', arguments: { stack: 'media' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('is not in the manifest');
  });

  it('reports unknown_stack when the stack has no compose file at the given ref', async () => {
    readFileFromRepoMock.mockImplementation(async (_repoPath: string, filePath: string) => {
      if (filePath === MANIFEST) return makeManifestYaml({ media: { host: 'nuc1' } });
      throw new MockFileNotFoundError(filePath);
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stack_compose', arguments: { stack: 'media' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('has no compose file');
  });

  it('surfaces an unexpected repo read failure as an error result', async () => {
    readFileFromRepoMock.mockImplementation(async () => {
      throw new Error('git object corrupt');
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_stack_compose', arguments: { stack: 'media' } });

    expect(result.isError).toBe(true);
  });
});

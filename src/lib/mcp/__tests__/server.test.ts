import { describe, it, expect, mock, afterEach } from 'bun:test';
import type { McpToolContext } from '@/lib/mcp/context';

const callOrder: string[] = [];

const registerHostTools = mock(() => {
  callOrder.push('hosts');
});
const registerLogTools = mock(() => {
  callOrder.push('logs');
});
const registerEventTools = mock(() => {
  callOrder.push('events');
});
const registerStatsTools = mock(() => {
  callOrder.push('stats');
});

mock.module('@/lib/mcp/tools/hosts', () => ({ registerHostTools }));
mock.module('@/lib/mcp/tools/logs', () => ({ registerLogTools }));
mock.module('@/lib/mcp/tools/events', () => ({ registerEventTools }));
mock.module('@/lib/mcp/tools/stats', () => ({ registerStatsTools }));

const { buildMcpServer } = await import('@/lib/mcp/server');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');

function makeCtx(): McpToolContext {
  return {
    pool: {} as McpToolContext['pool'],
    scopes: ['hosts:read'],
    callAgent: mock(async () => new Response('ok')),
  };
}

describe('buildMcpServer', () => {
  afterEach(() => {
    callOrder.length = 0;
    registerHostTools.mockClear();
    registerLogTools.mockClear();
    registerEventTools.mockClear();
    registerStatsTools.mockClear();
  });

  it('returns an McpServer instance', () => {
    const server = buildMcpServer(makeCtx());
    expect(server).toBeInstanceOf(McpServer);
  });

  it('registers all four tool groups exactly once with the server and context', () => {
    const ctx = makeCtx();
    const server = buildMcpServer(ctx);

    expect(registerHostTools).toHaveBeenCalledTimes(1);
    expect(registerLogTools).toHaveBeenCalledTimes(1);
    expect(registerEventTools).toHaveBeenCalledTimes(1);
    expect(registerStatsTools).toHaveBeenCalledTimes(1);

    expect(registerHostTools).toHaveBeenCalledWith(server, ctx);
    expect(registerLogTools).toHaveBeenCalledWith(server, ctx);
    expect(registerEventTools).toHaveBeenCalledWith(server, ctx);
    expect(registerStatsTools).toHaveBeenCalledWith(server, ctx);
  });

  it('registers the tool groups in hosts, logs, events, stats order', () => {
    buildMcpServer(makeCtx());

    expect(callOrder).toEqual(['hosts', 'logs', 'events', 'stats']);
  });
});

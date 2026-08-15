import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolContext } from '@/lib/mcp/context';
import { registerHostTools } from '@/lib/mcp/tools/hosts';
import { registerLogTools } from '@/lib/mcp/tools/logs';
import { registerEventTools } from '@/lib/mcp/tools/events';
import { registerStatsTools } from '@/lib/mcp/tools/stats';

const SERVER_NAME = 'homelab-manager';
const SERVER_VERSION = '1.0.0';

export function buildMcpServer(ctx: McpToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerHostTools(server, ctx);
  registerLogTools(server, ctx);
  registerEventTools(server, ctx);
  registerStatsTools(server, ctx);

  return server;
}

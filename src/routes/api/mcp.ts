import { createFileRoute } from '@tanstack/react-router';
import type { McpToolContext } from '@/lib/mcp/context';

/** Every scope a token needs at least one of to open an MCP session; mcp:read is the umbrella grant. */
const MCP_SCOPES = [
  'mcp:hosts:read',
  'mcp:logs:read',
  'mcp:events:read',
  'mcp:stats:read',
  'mcp:stacks:read',
  'mcp:findings:read',
  'mcp:findings:write',
  'mcp:read',
];

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

function hasAnyMcpScope(scopes: string[]): boolean {
  return scopes.some((scope) => MCP_SCOPES.includes(scope));
}

export const Route = createFileRoute('/api/mcp')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (process.env.MCP_ENABLED !== 'true') {
          return new Response('Not Found', { status: 404 });
        }

        const providedToken = extractBearerToken(request);
        if (!providedToken) {
          return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="mcp"' } });
        }

        const { databaseConnectionManager } = await import('@/lib/clients/database-client');
        const { loadDatabaseConfig } = await import('@/lib/config/database-config');
        const { ApiTokenRepository } = await import('@/lib/database/repositories/api-token-repository');
        const { findMatchingApiToken } = await import('@/lib/auth/api-token-auth');

        const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
        const pool = dbClient.getPool();
        const apiTokenRepo = new ApiTokenRepository(pool);

        const match = await findMatchingApiToken(providedToken, apiTokenRepo);
        if (!match) {
          return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="mcp"' } });
        }

        if (!hasAnyMcpScope(match.scopes)) {
          return new Response('Forbidden', {
            status: 403,
            headers: { 'WWW-Authenticate': 'Bearer realm="mcp", error="insufficient_scope"' },
          });
        }

        apiTokenRepo.updateLastUsed(match.tokenId).catch((err) => {
          console.error(
            `[Mcp] Failed to update last_used_at for token ${match.tokenId}:`,
            err instanceof Error ? err.message : err,
          );
        });

        const { buildMcpToolContext } = await import('@/lib/mcp/context');
        const { buildMcpServer } = await import('@/lib/mcp/server');
        const { WebStandardStreamableHTTPServerTransport } = await import(
          '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
        );

        const ctx: McpToolContext = await buildMcpToolContext(pool, match.scopes, request.signal);
        const server = buildMcpServer(ctx);
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });

        await server.connect(transport);

        return transport.handleRequest(request);
      },
    },
  },
});

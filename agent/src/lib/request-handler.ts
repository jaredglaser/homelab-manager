import type { Server } from 'bun';
import type { Duplex } from 'node:stream';
import { AGENT_IDENTITY_HEADER, AGENT_PROTOCOL_VERSION } from '../types';
import { HTTP_ENROLLMENT_ALLOWED_PATHS_TEXT, isAllowedOverPlainHttp, tlsErrorBody } from './tls-enroll';

export interface ExecWebSocketData {
  containerId: string;
  shell: string;
  cols: number;
  rows: number;
  execStream?: Duplex;
  execInstance?: { resize(opts: { h: number; w: number }): Promise<void> };
}

export interface AgentFetchDeps {
  authenticate: (headers: Headers, pathname: string) => Promise<Response | null>;
  restrictedPlainHttp: boolean;
  dockerAvailable: boolean;
  matchRoute: (request: Request, url: URL) => Promise<Response> | Response | null;
}

const EXEC_PATH = /^\/exec\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)$/;

export function createFetchHandler(deps: AgentFetchDeps) {
  const identity = String(AGENT_PROTOCOL_VERSION);

  const stamp = (response: Response): Response => {
    response.headers.set(AGENT_IDENTITY_HEADER, identity);
    return response;
  };

  return async function fetch(request: Request, server: Pick<Server<ExecWebSocketData>, 'upgrade'>): Promise<Response> {
    try {
      const url = new URL(request.url);

      const authError = await deps.authenticate(request.headers, url.pathname);
      if (authError) return stamp(authError);

      // Restricted plain-HTTP mode (TLS configured but no certificate yet):
      // only the enrollment endpoints are served, so the unencrypted window
      // cannot expose stats, container control, stack deploys or exec.
      if (deps.restrictedPlainHttp && !isAllowedOverPlainHttp(url.pathname)) {
        return stamp(Response.json(
          tlsErrorBody(
            'restricted_plain_http',
            `Agent TLS is configured but no certificate is enrolled yet, so this endpoint is not served over plain HTTP. Only ${HTTP_ENROLLMENT_ALLOWED_PATHS_TEXT} are available. Run TLS provisioning from the manager (Managed Hosts card), or see the agent TLS recovery steps in the self-hosting guide.`,
          ),
          { status: 403 },
        ));
      }

      // WebSocket upgrade for exec sessions: must happen before matchRoute since server.upgrade() is Bun-specific
      if (deps.dockerAvailable && request.headers.get('upgrade') === 'websocket') {
        const execMatch = EXEC_PATH.exec(url.pathname);
        if (execMatch) {
          const containerId = execMatch[1];
          const shell = url.searchParams.get('shell') ?? 'auto';
          const cols = Number(url.searchParams.get('cols') ?? 80);
          const rows = Number(url.searchParams.get('rows') ?? 24);
          const upgraded = server.upgrade(request, {
            data: { containerId, shell, cols, rows },
            headers: { [AGENT_IDENTITY_HEADER]: identity },
          });
          if (upgraded) return undefined as unknown as Response;
          return stamp(new Response('WebSocket upgrade failed', { status: 426 }));
        }
      }

      return stamp((await deps.matchRoute(request, url)) ?? new Response('Not Found', { status: 404 }));
    } catch (error) {
      console.error('Unhandled error in request handler:', error);
      return stamp(Response.json(tlsErrorBody('internal_error', 'Internal server error'), { status: 500 }));
    }
  };
}

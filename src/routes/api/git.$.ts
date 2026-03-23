import { createFileRoute } from '@tanstack/react-router';
import { createHash, timingSafeEqual } from 'crypto';

function constantTimeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Authenticate git HTTP requests via Bearer token.
 * CRITICAL: Pushes can trigger auto-deploys, so this endpoint must be authenticated.
 * Uses GIT_SERVER_TOKEN env var. Returns null if authenticated, or an error Response.
 */
function authenticateRequest(request: Request): Response | null {
  const token = process.env.GIT_SERVER_TOKEN;
  if (!token) {
    return new Response('Git server token not configured', { status: 500 });
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="git"' },
    });
  }

  let providedToken: string;
  if (authHeader.startsWith('Bearer ')) {
    providedToken = authHeader.slice('Bearer '.length);
  } else if (authHeader.startsWith('Basic ')) {
    // Git sends Basic auth as base64(username:password) — the token is the password
    let decoded: string;
    try {
      decoded = atob(authHeader.slice('Basic '.length));
    } catch {
      return new Response('Malformed Basic auth encoding', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Git", charset="UTF-8"' },
      });
    }
    const colonIndex = decoded.indexOf(':');
    providedToken = colonIndex >= 0 ? decoded.slice(colonIndex + 1) : decoded;
  } else {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="git"' },
    });
  }
  if (!constantTimeEqual(providedToken, token)) {
    return new Response('Forbidden', { status: 403 });
  }

  return null;
}

export const Route = createFileRoute('/api/git/$')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (process.env.DOCKER_MANAGEMENT_FEATURE_FLAG !== 'true') {
          return new Response('Not Found', { status: 404 });
        }

        const authError = authenticateRequest(request);
        if (authError) return authError;

        const { loadGitConfig } = await import('@/lib/config/git-config');
        const { parseGitPath, isGitInfoRefsRequest } = await import(
          '@/lib/git/git-http'
        );
        const { handleInfoRefs } = await import('@/lib/git/git-server');
        const { ensureRepoInitialized } = await import('@/lib/git/init-repo');

        const url = new URL(request.url);
        const pathInfo = parseGitPath(url.pathname);

        if (!pathInfo) {
          return new Response('Not Found', { status: 404 });
        }

        if (!isGitInfoRefsRequest('GET', pathInfo.action)) {
          return new Response('Method Not Allowed', { status: 405 });
        }

        const config = loadGitConfig();
        if (pathInfo.repo !== config.repoName) {
          return new Response('Not Found', { status: 404 });
        }
        const repoPath = config.repoPath;

        await ensureRepoInitialized();

        const service = url.searchParams.get('service');
        if (!service) {
          return new Response('Service parameter required', { status: 400 });
        }

        return handleInfoRefs(repoPath, service);
      },

      POST: async ({ request }) => {
        if (process.env.DOCKER_MANAGEMENT_FEATURE_FLAG !== 'true') {
          return new Response('Not Found', { status: 404 });
        }

        const authError = authenticateRequest(request);
        if (authError) return authError;

        const { loadGitConfig } = await import('@/lib/config/git-config');
        const {
          parseGitPath,
          isGitUploadPackRequest,
          isGitReceivePackRequest,
        } = await import('@/lib/git/git-http');
        const {
          handleUploadPack,
          handleReceivePack,
          getHeadOid,
        } = await import('@/lib/git/git-server');
        const { ensureRepoInitialized } = await import('@/lib/git/init-repo');

        const url = new URL(request.url);
        const pathInfo = parseGitPath(url.pathname);

        if (!pathInfo) {
          return new Response('Not Found', { status: 404 });
        }

        const config = loadGitConfig();
        if (pathInfo.repo !== config.repoName) {
          return new Response('Not Found', { status: 404 });
        }
        const repoPath = config.repoPath;

        await ensureRepoInitialized();

        if (isGitUploadPackRequest('POST', pathInfo.action)) {
          return handleUploadPack(repoPath, request.body);
        }

        if (isGitReceivePackRequest('POST', pathInfo.action)) {
          const { processPostReceive } = await import(
            '@/lib/git/post-receive-handler'
          );

          // Capture HEAD before push for diffing
          const oldHead = await getHeadOid(repoPath);

          const response = await handleReceivePack(repoPath, request.body);

          // Post-receive: diff and trigger deploys (non-blocking)
          const newHead = await getHeadOid(repoPath);
          if (oldHead && newHead && oldHead !== newHead) {
            processPostReceive(repoPath, oldHead, newHead)
              .then((requests) => {
                if (requests.length > 0) {
                  console.info(
                    `[GitServer] Post-receive generated ${requests.length} deploy request(s)`,
                  );
                }
              })
              .catch((err) => {
                console.error(
                  `[GitServer] Post-receive failed for ${oldHead}..${newHead}:`,
                  err instanceof Error ? err.message : err,
                  err instanceof Error ? err.stack : '',
                );
              });
          }

          return response;
        }

        return new Response('Not Found', { status: 404 });
      },
    },
  },
});

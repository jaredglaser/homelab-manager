import { createFileRoute } from '@tanstack/react-router';

/**
 * Authenticate git HTTP requests via Bearer token.
 * CRITICAL: Pushes can trigger auto-deploys, so this endpoint must be authenticated.
 * Uses GIT_SERVER_TOKEN env var. Returns null if authenticated, or an error Response.
 */
function authenticateRequest(request: Request): Response | null {
  const token = process.env.GIT_SERVER_TOKEN;
  if (!token) {
    // If no token is configured, reject all requests for safety
    return new Response('Git server token not configured', { status: 500 });
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer' },
    });
  }

  const providedToken = authHeader.slice('Bearer '.length);
  if (providedToken !== token) {
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
        const { initBareRepo } = await import('@/lib/git/repo');

        const url = new URL(request.url);
        const pathInfo = parseGitPath(url.pathname);

        if (!pathInfo) {
          return new Response('Not Found', { status: 404 });
        }

        if (!isGitInfoRefsRequest('GET', pathInfo.action)) {
          return new Response('Method Not Allowed', { status: 405 });
        }

        const config = loadGitConfig();
        const repoPath = config.repoPath;

        // Ensure repo exists
        await initBareRepo(repoPath);

        const service = url.searchParams.get('service');
        if (!service) {
          return new Response('Service parameter required', { status: 400 });
        }

        return handleInfoRefs(repoPath, service);
      },

      // NOTE: Post-receive wiring is added in Task 10 Step 5 after
      // post-receive-handler.ts exists. This initial version handles
      // only upload-pack and receive-pack without post-receive hooks.
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
        } = await import('@/lib/git/git-server');
        const { initBareRepo } = await import('@/lib/git/repo');

        const url = new URL(request.url);
        const pathInfo = parseGitPath(url.pathname);

        if (!pathInfo) {
          return new Response('Not Found', { status: 404 });
        }

        const config = loadGitConfig();
        const repoPath = config.repoPath;

        await initBareRepo(repoPath);

        if (isGitUploadPackRequest('POST', pathInfo.action)) {
          return handleUploadPack(repoPath, request.body);
        }

        if (isGitReceivePackRequest('POST', pathInfo.action)) {
          return handleReceivePack(repoPath, request.body);
        }

        return new Response('Not Found', { status: 404 });
      },
    },
  },
});

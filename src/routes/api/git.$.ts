import { createFileRoute } from '@tanstack/react-router';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthUser } from '@/lib/auth/types';

function constantTimeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Extract the raw token from the Authorization header.
 * Supports Bearer and Basic (password field) auth schemes.
 * Returns null if the header is missing or uses an unsupported scheme.
 */
function extractToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;

  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length);
  }

  if (authHeader.startsWith('Basic ')) {
    // Git sends Basic auth as base64(username:password), the token is the password
    try {
      const decoded = atob(authHeader.slice('Basic '.length));
      const colonIndex = decoded.indexOf(':');
      return colonIndex >= 0 ? decoded.slice(colonIndex + 1) : decoded;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Authenticate git HTTP requests using per-user git tokens.
 * CRITICAL: Pushes can trigger auto-deploys, so this endpoint must be authenticated.
 *
 * Auth flow:
 * 1. Extract token from Bearer or Basic auth
 * 2. Load all git tokens from DB and decrypt via JWE keyring
 * 3. Timing-safe compare against provided token
 * 4. On match: resolve user, check role, update last_used_at
 * 5. On no match: 403
 *
 * Returns the authenticated user on success, or a Response on failure.
 */
async function authenticateRequest(request: Request): Promise<AuthUser | Response> {
  const providedToken = extractToken(request);

  if (!providedToken) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="git"' },
    });
  }

  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { GitTokenRepository } = await import(
    '@/lib/database/repositories/git-token-repository'
  );
  const { UserRepository } = await import(
    '@/lib/database/repositories/user-repository'
  );
  const { requireRole } = await import('@/lib/auth/require-role');
  const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
  const { decryptValue } = await import('@/lib/crypto/encrypted-value');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const pool = dbClient.getPool();

  const gitTokenRepo = new GitTokenRepository(pool);
  const userRepo = new UserRepository(pool);

  const keyring = await loadMasterKeyring();
  const encryptedTokens = await gitTokenRepo.findAllEncrypted();

  let matchedTokenId: number | null = null;
  let matchedUserId: number | null = null;
  let decryptFailures = 0;

  for (const tokenRecord of encryptedTokens) {
    let decrypted: string;
    try {
      decrypted = await decryptValue(tokenRecord.encryptedToken, keyring);
    } catch (error) {
      decryptFailures++;
      console.error(`[GitAuth] Failed to decrypt token ${tokenRecord.id}:`, error instanceof Error ? error.message : error);
      continue;
    }

    if (constantTimeEqual(providedToken, decrypted)) {
      matchedTokenId = tokenRecord.id;
      matchedUserId = tokenRecord.userId;
      break;
    }
  }

  if (decryptFailures > 0 && decryptFailures === encryptedTokens.length) {
    console.error(`[GitAuth] ALL ${decryptFailures} token(s) failed to decrypt (Transit may be unavailable)`);
  }

  if (matchedTokenId === null || matchedUserId === null) {
    // 401 lets git CLI re-prompt for credentials on token mismatch
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="git"' },
    });
  }

  const userRow = await userRepo.findById(matchedUserId);
  if (!userRow) {
    return new Response('Forbidden', { status: 403 });
  }

  const user: AuthUser = {
    id: userRow.id,
    email: userRow.email,
    name: userRow.name,
    role: userRow.role,
  };

  try {
    requireRole('admin', 'operator')(user);
  } catch {
    return new Response('Forbidden', { status: 403 });
  }

  // Update last_used_at non-blocking; auth has already succeeded.
  gitTokenRepo.updateLastUsed(matchedTokenId).catch((err) => {
    console.error(
      `[GitAuth] Failed to update last_used_at for token ${matchedTokenId}:`,
      err instanceof Error ? err.message : err,
    );
  });

  return user;
}

export const Route = createFileRoute('/api/git/$')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (process.env.DOCKER_MANAGEMENT_FEATURE_FLAG !== 'true') {
          return new Response('Not Found', { status: 404 });
        }

        const authResult = await authenticateRequest(request);
        if (authResult instanceof Response) return authResult;

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

        const authResult = await authenticateRequest(request);
        if (authResult instanceof Response) return authResult;

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

          // HEAD before/after are captured inside the repo lock by
          // handleReceivePack so a concurrent push can't skew the diff range.
          const { response, oldHead, newHead } = await handleReceivePack(repoPath, request.body);

          // Post-receive: diff and trigger deploys (non-blocking)
          if (oldHead && newHead && oldHead !== newHead) {
            processPostReceive(repoPath, oldHead, newHead).catch((err) => {
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

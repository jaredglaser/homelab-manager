import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';
import { databaseConnectionManager } from '@/lib/clients/database-client';
import { loadDatabaseConfig } from '@/lib/config/database-config';
import { loadMasterKeyring } from '@/lib/crypto/master-key';
import { encryptValue } from '@/lib/crypto/encrypted-value';
import { GitTokenRepository } from '@/lib/database/repositories/git-token-repository';
import { hashGitToken } from '@/lib/git/git-token-auth';

/** Creates a git token. The raw token is returned once and never stored in plaintext. */
export const createGitToken = createServerFn()
  .middleware([authMiddleware])
  .validator(z.object({ label: z.string().min(1).max(100) }))
  .handler(async ({ data, context }): Promise<{ token: string }> => {
    requireRole('admin', 'operator')(context.user);

    const rawToken = randomBytes(32).toString('hex');

    const keyring = await loadMasterKeyring();
    const encryptedToken = await encryptValue(rawToken, keyring);

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new GitTokenRepository(dbClient.getPool());

    await repo.create({
      userId: context.user.id,
      encryptedToken,
      tokenHash: hashGitToken(rawToken),
      label: data.label,
    });

    return { token: rawToken }; // Show once, never again
  });

/**
 * List git tokens. Admins see all users' tokens. Operators see only their own.
 * Does not return encrypted values.
 */
export const listGitTokens = createServerFn()
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    requireRole('admin', 'operator')(context.user);

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new GitTokenRepository(dbClient.getPool());

    if (context.user.role === 'admin') {
      return repo.findAll();
    }
    const own = await repo.findByUserId(context.user.id);
    // Shape rows like GitTokenWithUser so the UI table renders identically for both scopes.
    return own.map((row) => ({
      ...row,
      userName: context.user.name,
      userEmail: context.user.email,
    }));
  });

/**
 * Revoke a git token by ID. Admins may revoke any token. Operators may revoke only their own.
 */
export const revokeGitToken = createServerFn()
  .middleware([authMiddleware])
  .validator(z.object({ tokenId: z.number() }))
  .handler(async ({ data, context }): Promise<void> => {
    requireRole('admin', 'operator')(context.user);

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new GitTokenRepository(dbClient.getPool());

    if (context.user.role === 'admin') {
      await repo.deleteById(data.tokenId);
      return;
    }
    await repo.deleteByIdAndUser(data.tokenId, context.user.id);
  });

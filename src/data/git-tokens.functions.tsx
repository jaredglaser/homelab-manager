import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';

/**
 * Create a new git token for the current admin user.
 * The raw token is returned once — it is never stored in plaintext.
 */
export const createGitToken = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(z.object({ label: z.string().min(1).max(100) }))
  .handler(async ({ data, context }): Promise<{ token: string }> => {
    requireRole('admin')(context.user);

    const { randomBytes } = await import('crypto');
    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
    const { encryptValue } = await import('@/lib/crypto/encrypted-value');
    const { GitTokenRepository } = await import(
      '@/lib/database/repositories/git-token-repository'
    );

    const rawToken = randomBytes(32).toString('hex');

    const keyring = await loadMasterKeyring();
    const encryptedToken = await encryptValue(rawToken, keyring);

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new GitTokenRepository(dbClient.getPool());

    await repo.create({
      userId: context.user.id,
      encryptedToken,
      label: data.label,
    });

    return { token: rawToken }; // Show once, never again
  });

/**
 * List all git tokens (admin only). Does not return encrypted values.
 */
export const listGitTokens = createServerFn()
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    requireRole('admin')(context.user);

    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { GitTokenRepository } = await import(
      '@/lib/database/repositories/git-token-repository'
    );

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new GitTokenRepository(dbClient.getPool());

    return repo.findAll();
  });

/**
 * Revoke a git token by ID (admin only).
 */
export const revokeGitToken = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(z.object({ tokenId: z.number() }))
  .handler(async ({ data, context }): Promise<void> => {
    requireRole('admin')(context.user);

    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { GitTokenRepository } = await import(
      '@/lib/database/repositories/git-token-repository'
    );

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new GitTokenRepository(dbClient.getPool());

    await repo.deleteById(data.tokenId);
  });

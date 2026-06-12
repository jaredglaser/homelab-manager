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

/** Creates a git token. The raw token is returned once and never stored in plaintext. */
export const createGitToken = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(z.object({ label: z.string().min(1).max(100) }))
  .handler(async ({ data, context }): Promise<{ token: string }> => {
    requireRole('admin')(context.user);

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

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new GitTokenRepository(dbClient.getPool());

    await repo.deleteById(data.tokenId);
  });

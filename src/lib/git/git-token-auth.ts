import '@tanstack/react-start/server-only';
import { createHash } from 'node:crypto';
import type { GitTokenRepository } from '@/lib/database/repositories/git-token-repository';

export interface GitTokenMatch {
  tokenId: number;
  userId: number;
}

export type GitTokenAuthRepo = Pick<GitTokenRepository, 'findByTokenHash'>;

export type GitTokenBackfillRepo = Pick<GitTokenRepository, 'findMissingHash' | 'setTokenHash'>;

export interface GitTokenBackfillResult {
  hashed: number;
  failed: number;
}

/** SHA-256 hex digest of the raw token; the value stored in git_tokens.token_hash. */
export function hashGitToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export async function findMatchingGitToken(
  providedToken: string,
  repo: GitTokenAuthRepo,
): Promise<GitTokenMatch | null> {
  const match = await repo.findByTokenHash(hashGitToken(providedToken));
  if (!match) return null;
  return { tokenId: match.id, userId: match.userId };
}

/**
 * Populate token_hash for rows predating migration 027. A SQL migration cannot do
 * this: the hash covers the raw token and only the app holds the master keyring.
 *
 * Never throws, so a failure cannot take down startup; rows that fail keep a NULL
 * hash for the next start to retry.
 */
export async function backfillGitTokenHashes(
  repo: GitTokenBackfillRepo,
  decryptToken: (encryptedToken: string) => Promise<string>,
): Promise<GitTokenBackfillResult> {
  const rows = await repo.findMissingHash();
  if (rows.length === 0) return { hashed: 0, failed: 0 };

  let hashed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const rawToken = await decryptToken(row.encryptedToken);
      await repo.setTokenHash(row.id, hashGitToken(rawToken));
      hashed++;
    } catch (error) {
      failed++;
      console.error(
        `[GitTokenBackfill] Token ${row.id} left unhashed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (failed === rows.length) {
    console.error(
      `[GitTokenBackfill] All ${failed} token(s) failed; the master keyring may be unavailable. ` +
        'Those tokens cannot authenticate until a later start hashes them.',
    );
  } else {
    console.info(`[GitTokenBackfill] Hashed ${hashed} token(s), ${failed} failed.`);
  }

  return { hashed, failed };
}

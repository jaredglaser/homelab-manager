import '@tanstack/react-start/server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { GitTokenRepository } from '@/lib/database/repositories/git-token-repository';

export interface GitTokenMatch {
  tokenId: number;
  userId: number;
}

export type GitTokenAuthRepo = Pick<
  GitTokenRepository,
  'findByTokenHash' | 'findLegacyEncrypted' | 'setTokenHash'
>;

/** SHA-256 hex digest of the raw token; the value stored in git_tokens.token_hash. */
export function hashGitToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Match a presented git token against stored tokens.
 *
 * Fast path: single indexed lookup on token_hash plus timingSafeEqual,
 * mirroring the sessions pattern. Rows created before migration 024 have a
 * NULL token_hash; only those are decrypted and compared, and the hash is
 * backfilled on a successful match so the next request takes the fast path.
 *
 * @param decryptToken decrypts a stored encrypted_token value to plaintext;
 * only invoked on the legacy fallback path.
 */
export async function findMatchingGitToken(
  providedToken: string,
  repo: GitTokenAuthRepo,
  decryptToken: (encryptedToken: string) => Promise<string>,
): Promise<GitTokenMatch | null> {
  const providedHash = hashGitToken(providedToken);

  const hashed = await repo.findByTokenHash(providedHash);
  if (hashed) {
    const storedHash = Buffer.from(hashed.tokenHash, 'hex');
    const providedHashBytes = Buffer.from(providedHash, 'hex');
    // timingSafeEqual throws on length mismatch, so guard against a
    // malformed stored hash instead of failing the whole request.
    if (storedHash.length === providedHashBytes.length && timingSafeEqual(storedHash, providedHashBytes)) {
      return { tokenId: hashed.id, userId: hashed.userId };
    }
  }

  const legacyTokens = await repo.findLegacyEncrypted();
  let decryptFailures = 0;

  for (const tokenRecord of legacyTokens) {
    let decrypted: string;
    try {
      decrypted = await decryptToken(tokenRecord.encryptedToken);
    } catch (error) {
      decryptFailures++;
      console.error(
        `[GitAuth] Failed to decrypt token ${tokenRecord.id}:`,
        error instanceof Error ? error.message : error,
      );
      continue;
    }

    if (constantTimeEqual(providedToken, decrypted)) {
      // Backfill non-blocking; the match already succeeded and the next
      // request simply retries the legacy scan if this write fails.
      repo.setTokenHash(tokenRecord.id, providedHash).catch((err) => {
        console.error(
          `[GitAuth] Failed to backfill token_hash for token ${tokenRecord.id}:`,
          err instanceof Error ? err.message : err,
        );
      });
      return { tokenId: tokenRecord.id, userId: tokenRecord.userId };
    }
  }

  if (decryptFailures > 0 && decryptFailures === legacyTokens.length) {
    console.error(
      `[GitAuth] ALL ${decryptFailures} legacy token(s) failed to decrypt (keyring may be unavailable)`,
    );
  }

  return null;
}

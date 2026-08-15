import { describe, it, expect, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { findMatchingApiToken, hashApiToken, hasScope } from '@/lib/auth/api-token-auth';
import type { ApiTokenAuthRepo } from '@/lib/auth/api-token-auth';
import type { ApiTokenHashMatch } from '@/lib/database/repositories/api-token-repository';

const RAW_TOKEN = 'a'.repeat(64);
const RAW_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');

describe('hashApiToken', () => {
  it('returns the SHA-256 hex digest of the raw token', () => {
    expect(hashApiToken(RAW_TOKEN)).toBe(RAW_HASH);
    expect(hashApiToken(RAW_TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different digests for different tokens', () => {
    expect(hashApiToken(RAW_TOKEN)).not.toBe(hashApiToken('b'.repeat(64)));
  });
});

describe('findMatchingApiToken', () => {
  it('matches via the indexed hash lookup', async () => {
    const repo: ApiTokenAuthRepo = {
      findByTokenHash: async (): Promise<ApiTokenHashMatch | null> => ({
        id: 3,
        scopes: ['stacks:read'],
      }),
    };

    const result = await findMatchingApiToken(RAW_TOKEN, repo);

    expect(result).toEqual({ tokenId: 3, scopes: ['stacks:read'] });
  });

  it('hashes the provided token before looking it up', async () => {
    const findByTokenHash = mock(async (): Promise<ApiTokenHashMatch | null> => null);

    await findMatchingApiToken(RAW_TOKEN, { findByTokenHash });

    expect(findByTokenHash).toHaveBeenCalledWith(RAW_HASH);
  });

  it('returns null for an unknown token', async () => {
    const repo: ApiTokenAuthRepo = {
      findByTokenHash: async (): Promise<ApiTokenHashMatch | null> => null,
    };

    const result = await findMatchingApiToken(RAW_TOKEN, repo);

    expect(result).toBeNull();
  });
});

describe('hasScope', () => {
  it('returns true when the required scope is present', () => {
    expect(hasScope(['stacks:read', 'stacks:deploy'], 'stacks:deploy')).toBe(true);
  });

  it('returns false when the required scope is absent', () => {
    expect(hasScope(['stacks:read'], 'stacks:deploy')).toBe(false);
  });

  it('returns false for an empty scopes array', () => {
    expect(hasScope([], 'stacks:read')).toBe(false);
  });
});

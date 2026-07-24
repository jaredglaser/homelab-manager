import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { findMatchingGitToken, hashGitToken } from '@/lib/git/git-token-auth';
import type { GitTokenAuthRepo } from '@/lib/git/git-token-auth';
import type { GitTokenHashMatch, GitTokenWithEncrypted } from '@/lib/database/repositories/git-token-repository';

const RAW_TOKEN = 'a'.repeat(64);
const RAW_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');

function createRepo(overrides: Partial<GitTokenAuthRepo> = {}): GitTokenAuthRepo & {
  findByTokenHash: ReturnType<typeof mock>;
  findLegacyEncrypted: ReturnType<typeof mock>;
  setTokenHash: ReturnType<typeof mock>;
} {
  return {
    findByTokenHash: mock(async (): Promise<GitTokenHashMatch | null> => null),
    findLegacyEncrypted: mock(async (): Promise<GitTokenWithEncrypted[]> => []),
    setTokenHash: mock(async () => {}),
    ...overrides,
  } as never;
}

describe('hashGitToken', () => {
  it('returns the SHA-256 hex digest of the raw token', () => {
    expect(hashGitToken(RAW_TOKEN)).toBe(RAW_HASH);
    expect(hashGitToken(RAW_TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('findMatchingGitToken', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('matches via indexed hash lookup without touching legacy rows or decrypting', async () => {
    const repo = createRepo({
      findByTokenHash: mock(async () => ({ id: 3, userId: 11, tokenHash: RAW_HASH })),
    });
    const decryptToken = mock(async () => 'never');

    const result = await findMatchingGitToken(RAW_TOKEN, repo, decryptToken);

    expect(result).toEqual({ tokenId: 3, userId: 11 });
    expect(repo.findByTokenHash).toHaveBeenCalledWith(RAW_HASH);
    expect(repo.findLegacyEncrypted).not.toHaveBeenCalled();
    expect(decryptToken).not.toHaveBeenCalled();
  });

  it('matches a legacy row by decrypting and backfills its hash', async () => {
    const repo = createRepo({
      findLegacyEncrypted: mock(async () => [
        { id: 1, userId: 10, encryptedToken: 'enc:other' },
        { id: 2, userId: 20, encryptedToken: 'enc:match' },
      ]),
    });
    const decryptToken = mock(async (enc: string) =>
      enc === 'enc:match' ? RAW_TOKEN : 'b'.repeat(64),
    );

    const result = await findMatchingGitToken(RAW_TOKEN, repo, decryptToken);

    expect(result).toEqual({ tokenId: 2, userId: 20 });
    expect(repo.setTokenHash).toHaveBeenCalledWith(2, RAW_HASH);
  });

  it('falls through without throwing when the stored hash is malformed', async () => {
    const repo = createRepo({
      findByTokenHash: mock(async () => ({ id: 3, userId: 11, tokenHash: 'abc' })),
    });
    const decryptToken = mock(async () => 'never');

    const result = await findMatchingGitToken(RAW_TOKEN, repo, decryptToken);

    expect(result).toBeNull();
    expect(repo.findLegacyEncrypted).toHaveBeenCalledTimes(1);
  });

  it('returns null when neither hashed nor legacy rows match', async () => {
    const repo = createRepo({
      findLegacyEncrypted: mock(async () => [
        { id: 1, userId: 10, encryptedToken: 'enc:other' },
      ]),
    });
    const decryptToken = mock(async () => 'b'.repeat(64));

    const result = await findMatchingGitToken(RAW_TOKEN, repo, decryptToken);

    expect(result).toBeNull();
    expect(repo.setTokenHash).not.toHaveBeenCalled();
  });

  it('skips legacy rows that fail to decrypt and still matches a later row', async () => {
    const repo = createRepo({
      findLegacyEncrypted: mock(async () => [
        { id: 1, userId: 10, encryptedToken: 'enc:broken' },
        { id: 2, userId: 20, encryptedToken: 'enc:match' },
      ]),
    });
    const decryptToken = mock(async (enc: string) => {
      if (enc === 'enc:broken') throw new Error('bad jwe');
      return RAW_TOKEN;
    });

    const result = await findMatchingGitToken(RAW_TOKEN, repo, decryptToken);

    expect(result).toEqual({ tokenId: 2, userId: 20 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('logs when every legacy row fails to decrypt and returns null', async () => {
    const repo = createRepo({
      findLegacyEncrypted: mock(async () => [
        { id: 1, userId: 10, encryptedToken: 'enc:broken1' },
        { id: 2, userId: 20, encryptedToken: 'enc:broken2' },
      ]),
    });
    const decryptToken = mock(async () => {
      throw new Error('keyring unavailable');
    });

    const result = await findMatchingGitToken(RAW_TOKEN, repo, decryptToken);

    expect(result).toBeNull();
    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(messages.some((m: string) => m.includes('ALL 2 legacy token(s) failed to decrypt'))).toBe(true);
  });

  it('does not throw when the backfill write fails', async () => {
    let onErrorLogged!: (message: string) => void;
    const errorLogged = new Promise<string>((resolve) => {
      onErrorLogged = resolve;
    });
    errorSpy.mockImplementation((message: unknown) => onErrorLogged(String(message)));

    const repo = createRepo({
      findLegacyEncrypted: mock(async () => [
        { id: 1, userId: 10, encryptedToken: 'enc:match' },
      ]),
      setTokenHash: mock(async () => {
        throw new Error('db write failed');
      }),
    });
    const decryptToken = mock(async () => RAW_TOKEN);

    const result = await findMatchingGitToken(RAW_TOKEN, repo, decryptToken);

    expect(result).toEqual({ tokenId: 1, userId: 10 });
    expect(await errorLogged).toContain('Failed to backfill token_hash');
  });
});

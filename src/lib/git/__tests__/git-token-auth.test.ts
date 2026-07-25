import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  backfillGitTokenHashes,
  findMatchingGitToken,
  hashGitToken,
} from '@/lib/git/git-token-auth';
import type { GitTokenAuthRepo, GitTokenBackfillRepo } from '@/lib/git/git-token-auth';
import type {
  GitTokenHashMatch,
  GitTokenWithEncrypted,
} from '@/lib/database/repositories/git-token-repository';

const RAW_TOKEN = 'a'.repeat(64);
const RAW_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');
const OTHER_TOKEN = 'b'.repeat(64);
const OTHER_HASH = createHash('sha256').update(OTHER_TOKEN).digest('hex');

describe('hashGitToken', () => {
  it('returns the SHA-256 hex digest of the raw token', () => {
    expect(hashGitToken(RAW_TOKEN)).toBe(RAW_HASH);
    expect(hashGitToken(RAW_TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('findMatchingGitToken', () => {
  it('matches via the indexed hash lookup', async () => {
    const repo: GitTokenAuthRepo = {
      findByTokenHash: mock(async (): Promise<GitTokenHashMatch | null> => ({ id: 3, userId: 11 })),
    };

    const result = await findMatchingGitToken(RAW_TOKEN, repo);

    expect(result).toEqual({ tokenId: 3, userId: 11 });
    expect(repo.findByTokenHash).toHaveBeenCalledWith(RAW_HASH);
  });

  it('returns null for an unknown token after a single lookup', async () => {
    const findByTokenHash = mock(async (): Promise<GitTokenHashMatch | null> => null);

    const result = await findMatchingGitToken(RAW_TOKEN, { findByTokenHash });

    expect(result).toBeNull();
    expect(findByTokenHash).toHaveBeenCalledTimes(1);
  });
});

describe('backfillGitTokenHashes', () => {
  let errorSpy: ReturnType<typeof spyOn>;
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    infoSpy = spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    infoSpy.mockRestore();
  });

  function createRepo(rows: GitTokenWithEncrypted[]): GitTokenBackfillRepo & {
    setTokenHash: ReturnType<typeof mock>;
  } {
    return {
      findMissingHash: mock(async () => rows),
      setTokenHash: mock(async () => {}),
    };
  }

  it('hashes every row missing a hash', async () => {
    const repo = createRepo([
      { id: 1, userId: 10, encryptedToken: 'enc:a' },
      { id: 2, userId: 20, encryptedToken: 'enc:b' },
    ]);
    const decryptToken = mock(async (enc: string) => (enc === 'enc:a' ? RAW_TOKEN : OTHER_TOKEN));

    const result = await backfillGitTokenHashes(repo, decryptToken);

    expect(result).toEqual({ hashed: 2, failed: 0 });
    expect(repo.setTokenHash).toHaveBeenNthCalledWith(1, 1, RAW_HASH);
    expect(repo.setTokenHash).toHaveBeenNthCalledWith(2, 2, OTHER_HASH);
  });

  it('does not decrypt anything when no rows are missing a hash', async () => {
    const repo = createRepo([]);
    const decryptToken = mock(async () => RAW_TOKEN);

    const result = await backfillGitTokenHashes(repo, decryptToken);

    expect(result).toEqual({ hashed: 0, failed: 0 });
    expect(decryptToken).not.toHaveBeenCalled();
    expect(repo.setTokenHash).not.toHaveBeenCalled();
  });

  it('continues past a row that fails to decrypt and leaves it unhashed', async () => {
    const repo = createRepo([
      { id: 1, userId: 10, encryptedToken: 'enc:broken' },
      { id: 2, userId: 20, encryptedToken: 'enc:ok' },
    ]);
    const decryptToken = mock(async (enc: string) => {
      if (enc === 'enc:broken') throw new Error('bad jwe');
      return RAW_TOKEN;
    });

    const result = await backfillGitTokenHashes(repo, decryptToken);

    expect(result).toEqual({ hashed: 1, failed: 1 });
    expect(repo.setTokenHash).toHaveBeenCalledTimes(1);
    expect(repo.setTokenHash).toHaveBeenCalledWith(2, RAW_HASH);
    expect(String(errorSpy.mock.calls[0][0])).toContain('Token 1 left unhashed');
  });

  it('counts a failed hash write as unhashed and keeps going', async () => {
    const repo = createRepo([
      { id: 1, userId: 10, encryptedToken: 'enc:a' },
      { id: 2, userId: 20, encryptedToken: 'enc:b' },
    ]);
    repo.setTokenHash = mock(async (id: number) => {
      if (id === 1) throw new Error('db write failed');
    });
    const decryptToken = mock(async () => RAW_TOKEN);

    const result = await backfillGitTokenHashes(repo, decryptToken);

    expect(result).toEqual({ hashed: 1, failed: 1 });
  });

  it('logs loudly and leaves every row intact when the keyring is unavailable', async () => {
    const repo = createRepo([
      { id: 1, userId: 10, encryptedToken: 'enc:a' },
      { id: 2, userId: 20, encryptedToken: 'enc:b' },
    ]);
    const decryptToken = mock(async () => {
      throw new Error('MASTER_KEY environment variable must be set');
    });

    const result = await backfillGitTokenHashes(repo, decryptToken);

    expect(result).toEqual({ hashed: 0, failed: 2 });
    expect(repo.setTokenHash).not.toHaveBeenCalled();
    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(messages.some((m: string) => m.includes('All 2 token(s) failed'))).toBe(true);
  });

  it('makes a backfilled token authenticate on the indexed path', async () => {
    const stored = new Map<number, string>();
    const backfillRepo: GitTokenBackfillRepo = {
      findMissingHash: async () => [{ id: 7, userId: 42, encryptedToken: 'enc:a' }],
      setTokenHash: async (id, tokenHash) => {
        stored.set(id, tokenHash);
      },
    };

    await backfillGitTokenHashes(backfillRepo, async () => RAW_TOKEN);

    const authRepo: GitTokenAuthRepo = {
      findByTokenHash: async (tokenHash) =>
        stored.get(7) === tokenHash ? { id: 7, userId: 42 } : null,
    };

    expect(await findMatchingGitToken(RAW_TOKEN, authRepo)).toEqual({ tokenId: 7, userId: 42 });
    expect(await findMatchingGitToken(OTHER_TOKEN, authRepo)).toBeNull();
  });
});
